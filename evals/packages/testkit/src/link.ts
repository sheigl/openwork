import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort } from "@openwork/cdp";
import type { ChildProcess } from "node:child_process";
import type { DenRef } from "@openwork/behaviors";

export type LinkRule = { pathPrefix?: string; times?: number; everyNth?: number } & (
  | { kind: "latency"; delayMs: number; jitterMs?: number }
  | { kind: "status"; statusCode: number; body?: unknown }
  | { kind: "reset" }
  | { kind: "stall" }
);

export type LinkProfile = "baseline" | "vpn-flaky-emulated";

export interface LinkRequestEntry {
  method: string;
  path: string;
  status: number;
  faulted: boolean;
  fault?: string;
  phase: string;
  profile: LinkProfile;
  at: number;
}

export interface LinkLog {
  requests: LinkRequestEntry[];
  refusedConnections: Record<string, number>;
  phase: string;
  profile: LinkProfile;
}

export interface LinkStats {
  requests: number;
  faults: number;
  refusedConnections: number;
  phase: string;
  profile: LinkProfile;
}

export interface DenLink extends AsyncDisposable {
  /** Den ref as seen by the app: webUrl is the shaped data URL. */
  ref: DenRef;
  admin: {
    phase(name: string, profile?: LinkProfile): Promise<void>;
    rules(rules: LinkRule[]): Promise<void>;
    bandwidth(bytesPerSec: number | null): Promise<void>;
    offline(durationMs: number): Promise<void>;
    clear(): Promise<void>;
    requests(): Promise<LinkLog>;
    stats(): Promise<LinkStats>;
    health(): Promise<{ ok: boolean; phase: string; offline: boolean }>;
  };
}

interface LinkPlacement {
  dataUrl: string;
  adminUrl: string;
  dispose(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is LinkProfile {
  return value === "baseline" || value === "vpn-flaky-emulated";
}

function parseHealth(value: unknown): { ok: boolean; phase: string; offline: boolean } {
  if (isRecord(value) && typeof value.ok === "boolean" && typeof value.phase === "string" && typeof value.offline === "boolean") {
    return { ok: value.ok, phase: value.phase, offline: value.offline };
  }
  throw new Error("Link health response has an invalid shape.");
}

function parseRequestEntry(value: unknown): LinkRequestEntry {
  if (!isRecord(value)
    || typeof value.method !== "string"
    || typeof value.path !== "string"
    || typeof value.status !== "number"
    || typeof value.faulted !== "boolean"
    || (value.fault !== undefined && typeof value.fault !== "string")
    || typeof value.phase !== "string"
    || !isProfile(value.profile)
    || typeof value.at !== "number") {
    throw new Error("Link request entry has an invalid shape.");
  }
  return {
    method: value.method,
    path: value.path,
    status: value.status,
    faulted: value.faulted,
    ...(value.fault === undefined ? {} : { fault: value.fault }),
    phase: value.phase,
    profile: value.profile,
    at: value.at,
  };
}

function parseLog(value: unknown): LinkLog {
  if (!isRecord(value) || !Array.isArray(value.requests) || !isRecord(value.refusedConnections) || typeof value.phase !== "string" || !isProfile(value.profile)) {
    throw new Error("Link requests response has an invalid shape.");
  }
  const refusedConnections: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.refusedConnections)) {
    if (typeof count !== "number") throw new Error("Link refusal count has an invalid shape.");
    refusedConnections[name] = count;
  }
  return { requests: value.requests.map(parseRequestEntry), refusedConnections, phase: value.phase, profile: value.profile };
}

function parseStats(value: unknown): LinkStats {
  if (!isRecord(value)
    || typeof value.requests !== "number"
    || typeof value.faults !== "number"
    || typeof value.refusedConnections !== "number"
    || typeof value.phase !== "string"
    || !isProfile(value.profile)) {
    throw new Error("Link stats response has an invalid shape.");
  }
  return {
    requests: value.requests,
    faults: value.faults,
    refusedConnections: value.refusedConnections,
    phase: value.phase,
    profile: value.profile,
  };
}

async function adminJson(baseUrl: string, path: string, token: string, body?: object): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Den link admin ${path} failed with HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Den link admin ${path} returned invalid JSON: ${text.slice(0, 1_000)}`);
  }
}

async function distinctLocalPorts(): Promise<[number, number]> {
  const port = await allocateFreePort();
  let adminPort = await allocateFreePort();
  while (adminPort === port) adminPort = await allocateFreePort();
  return [port, adminPort];
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function localPlacement(upstream: DenRef, token: string): Promise<LinkPlacement> {
  const [port, adminPort] = await distinctLocalPorts();
  const script = fileURLToPath(new URL("./link-server.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--upstream", upstream.webUrl, "--port", String(port), "--admin-port", String(adminPort)], {
    env: { ...process.env, LINK_ADMIN_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("Den link child process did not expose output streams.");
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const listening = `link-server listening data=${port} admin=${adminPort}`;
  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes(listening) && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Den link exited during startup (${child.exitCode}): ${output.slice(-2_000)}`);
      await delay(50);
    }
    if (!output.includes(listening)) throw new Error(`Timed out waiting for Den link startup: ${output.slice(-2_000)}`);
    await adminJson(`http://127.0.0.1:${adminPort}`, "/health", token);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  let disposed = false;
  return {
    dataUrl: `http://127.0.0.1:${port}`,
    adminUrl: `http://127.0.0.1:${adminPort}`,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      child.kill("SIGTERM");
      const exited = waitForExit(child);
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
    },
  };
}

export async function denLink(upstream: DenRef): Promise<DenLink> {
  const token = randomBytes(32).toString("hex");
  const placement = await localPlacement(upstream, token);
  const post = async (path: string, body: object): Promise<void> => {
    await adminJson(placement.adminUrl, path, token, body);
  };
  return {
    ref: { apiUrl: `${placement.dataUrl}/api/den`, webUrl: placement.dataUrl },
    admin: {
      phase: (name, profile) => post("/phase", profile === undefined ? { name } : { name, profile }),
      rules: (newRules) => post("/rules", { rules: newRules }),
      bandwidth: (rate) => post("/bandwidth", { bytesPerSec: rate }),
      offline: (durationMs) => post("/offline", { durationMs }),
      clear: () => post("/clear", {}),
      async requests(): Promise<LinkLog> {
        return parseLog(await adminJson(placement.adminUrl, "/requests", token));
      },
      async stats(): Promise<LinkStats> {
        return parseStats(await adminJson(placement.adminUrl, "/stats", token));
      },
      async health(): Promise<{ ok: boolean; phase: string; offline: boolean }> {
        return parseHealth(await adminJson(placement.adminUrl, "/health", token));
      },
    },
    [Symbol.asyncDispose]: () => placement.dispose(),
  };
}
