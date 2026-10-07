import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { waitUntilInteractive } from "@openwork/behaviors";
import { addInitScript, evaluate, navigate } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { startLocalRuntime } from "./app-web-runtime.ts";
import type { AppWebRuntime, AppWebRuntimeOptions } from "./app-web-runtime.ts";
import type { MockBoot, MockHandle } from "./mock.ts";
import type { Place } from "./place.ts";
import { observeAppWebNetwork } from "./app-web-network.ts";
import { reloadOnceIfEntryFails } from "./app-web-entry.ts";

declare global {
  interface Window { __openworkEvalBootErrors?: string[] }
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export interface SeedAppWebOptions {
  workspacePath: string;
  engine?: AppWebRuntimeOptions["engine"];
  den?: AppWebRuntimeOptions["den"];
  webPort?: number;
  emptyWorkspace?: boolean;
  /** Explicit fixture runtime settings; the normal isolated environment is retained. */
  env?: Record<string, string>;
  syntheticPreactivatedDenOrigin?: string;
  name?: string;
  mocks?: Record<string, MockBoot>;
  headless?: boolean;
}

/** A test-owned real app-web stack. This is distinct from seed.web(), which drives Den. */
export interface AppWeb extends AttachedSurface {
  webUrl: string;
  openworkUrl: string;
  workspaceRoot: string;
  mocks: Record<string, MockHandle>;
  actualSourceSha: string | null;
}

function safeWorldSegment(value: string): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-") || "app-web";
}

function attachAppWebMetadata(
  surface: AttachedSurface,
  metadata: Pick<AppWeb, "webUrl" | "openworkUrl" | "workspaceRoot" | "mocks" | "actualSourceSha">,
  stop: () => Promise<void>,
): asserts surface is AppWeb {
  Object.assign(surface, metadata);
  surface[Symbol.asyncDispose] = stop;
  // Assign stop last so setup-error cleanup still sees Chrome's original
  // disposer if augmentation itself ever fails.
  surface.stop = stop;
}

function cleanupError(label: string, error: unknown): Error {
  return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

async function cleanupMocks(mocks: Record<string, MockHandle>, errors: Error[]): Promise<void> {
  for (const [name, mock] of Object.entries(mocks)) {
    await mock.stop().catch((error: unknown) => errors.push(cleanupError(`Mock ${name} cleanup failed`, error)));
  }
}

async function cleanupAppWeb(input: {
  browserStop: (() => Promise<void>) | null;
  runtime: AppWebRuntime | null;
  mocks: Record<string, MockHandle>;
}): Promise<void> {
  const errors: Error[] = [];
  let runtimeStopped = input.runtime === null;

  if (input.browserStop) {
    await input.browserStop().catch((error: unknown) => errors.push(cleanupError("Chrome cleanup failed", error)));
  }
  if (input.runtime) {
    try {
      await input.runtime.stop();
      runtimeStopped = true;
    } catch (error) {
      errors.push(cleanupError("Headless app runtime cleanup failed; ownership manifest preserved", error));
    }
  }
  await cleanupMocks(input.mocks, errors);
  if (runtimeStopped && input.runtime) {
    for (const path of [input.runtime.runtimeDirectory, input.runtime.fixtureRoot]) {
      await rm(path, { recursive: true, force: true })
        .catch((error: unknown) => errors.push(cleanupError(`Temporary path cleanup failed for ${path}`, error)));
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, "Hermetic app-web cleanup failed");
}

async function bootLocalMocks(place: Place, definitions: Record<string, MockBoot>): Promise<Record<string, MockHandle>> {
  const mocks: Record<string, MockHandle> = {};
  try {
    for (const [name, definition] of Object.entries(definitions)) {
      const booted = await definition.boot(place);
      mocks[name] = booted.handle;
    }
    return mocks;
  } catch (error) {
    const failures: unknown[] = [error];
    for (const mock of Object.values(mocks)) await mock.stop().catch((failure: unknown) => failures.push(failure));
    if (failures.length > 1) throw new AggregateError(failures, "Local mock setup and cleanup failed");
    throw error;
  }
}

/** Real Vite app + managed openwork-server + fresh Chrome, launched on the local machine. */
export async function appWeb(options: SeedAppWebOptions & { place: Place }): Promise<AppWeb> {
  const workspaceRoot = options.workspacePath;
  const worldName = `${safeWorldSegment(options.name ?? "app-web")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let runtime: AppWebRuntime | null = null;
  let browser: AttachedSurface | null = null;
  let mocks: Record<string, MockHandle> = {};
  let localSourceSha: string | null = null;
  try {
    // Capture only the commit identity, before mocks or app processes launch.
    // Do not expose git stderr, checkout paths, or environment in evidence.
    try {
      const receipt = await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 10_000,
      });
      localSourceSha = receipt.stdout.trim();
    } catch {
      throw new Error("Could not capture local app-web source SHA before launch.");
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(localSourceSha)) {
      throw new Error("Invalid local app-web source SHA receipt.");
    }
    mocks = await bootLocalMocks(options.place, options.mocks ?? {});
    runtime = await startLocalRuntime(worldName, workspaceRoot, { engine: options.engine, den: options.den, webPort: options.webPort, syntheticPreactivatedDenOrigin: options.syntheticPreactivatedDenOrigin, env: options.env, emptyWorkspace: options.emptyWorkspace });
    browser = await chrome({
      name: worldName,
      host: options.place.host(),
      startUrl: "about:blank",
      headless: options.headless ?? true,
    });
    if (browser.handle.kind !== "chrome") throw new Error("App-web requires a chrome handle.");
    browser.handle.meta = { ...browser.handle.meta, actualSourceSha: localSourceSha };
    // Observe entry-bundle failures before navigation. The static startup page
    // survives a broken module load, so a DOM timeout alone hides the cause.
    await addInitScript(browser.client, () => {
      window.__openworkEvalBootErrors = [];
      window.addEventListener("error", event => {
        const target = event.target;
        const source = target instanceof HTMLScriptElement ? new URL(target.src).pathname : event.filename?.split("?")[0];
        if ((window.__openworkEvalBootErrors?.length ?? 0) < 10) window.__openworkEvalBootErrors?.push(`${event.message || "Resource failed"} (${source || "unknown"})`.slice(0, 1000));
      }, true);
      window.addEventListener("unhandledrejection", event => {
        const reason = event.reason;
        if ((window.__openworkEvalBootErrors?.length ?? 0) < 10) window.__openworkEvalBootErrors?.push(String(reason instanceof Error ? reason.message : reason).slice(0, 1000));
      });
    });
    const network = await observeAppWebNetwork(browser.client.webSocketDebuggerUrl, runtime.webUrl);
    const surface = browser;
    const entry = reloadOnceIfEntryFails({
      client: () => surface.client,
      url: runtime.webUrl,
      describe: () => `Network failures: ${JSON.stringify(network.failures)} Page timeline: ${JSON.stringify(network.summary())}`,
    });
    try {
      await navigate(browser.client, runtime.webUrl);
      try {
        await waitUntilInteractive(browser, { timeoutMs: 60_000 });
      } finally {
        await entry.stop();
      }
    } catch (error) {
      const boot = await evaluate(browser.client, () => ({
        errors: (window.__openworkEvalBootErrors ?? []).slice(0, 10),
        failedResources: performance.getEntriesByType("resource")
          .filter(entry => entry instanceof PerformanceResourceTiming && entry.responseStatus >= 400)
          .map(entry => ({ path: new URL(entry.name).pathname,
            status: entry instanceof PerformanceResourceTiming ? entry.responseStatus : 0 })).slice(0, 20),
      })).catch(() => null);
      const logTail = async (path: string | undefined, lines: number) => path
        ? (await readFile(path, "utf8").catch(() => "")).split("\n").filter(line => line.trim())
          .slice(-lines).map(line => line.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300))
        : [];
      const viteEvents = await logTail(join(runtime.runtimeDirectory, "web.log"), 25);
      const chromeLog = browser.handle.meta?.log;
      const chromeEvents = await logTail(typeof chromeLog === "string" ? chromeLog : undefined, 15);
      const webUrl = runtime.webUrl;
      const moduleProbes = await Promise.all([...new Set(network.failures.map(failure => failure.path))].slice(0, 3).map(async path => {
        try {
          const response = await fetch(new URL(path, webUrl), { signal: AbortSignal.timeout(5_000) });
          const bytes = (await response.arrayBuffer()).byteLength;
          return { path, status: response.status, type: response.headers.get("content-type"), bytes };
        } catch {
          return { path, unavailable: true };
        }
      }));
      throw new Error(`${error instanceof Error ? error.message : String(error)} Entry reloaded after a dropped module graph: ${entry.reloaded()}. Startup diagnostics: ${JSON.stringify(boot)} Network failures: ${JSON.stringify(network.failures)} Browser errors: ${JSON.stringify(network.browserErrors)} Page timeline: ${JSON.stringify(network.summary())} Vite events: ${JSON.stringify(viteEvents)} Chrome log: ${JSON.stringify(chromeEvents)} Module probes: ${JSON.stringify(moduleProbes)}`, { cause: error });
    } finally {
      network.close();
    }

    const originalBrowserStop = browser.stop.bind(browser);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await cleanupAppWeb({ browserStop: originalBrowserStop, runtime, mocks });
    };
    attachAppWebMetadata(browser, {
      webUrl: runtime.webUrl,
      openworkUrl: runtime.openworkUrl,
      workspaceRoot,
      mocks,
      actualSourceSha: localSourceSha,
    }, stop);
    return browser;
  } catch (error) {
    try {
      await cleanupAppWeb({
        browserStop: browser ? browser.stop.bind(browser) : null,
        runtime,
        mocks,
      });
    } catch (cleanupFailure) {
      throw new AggregateError([error, cleanupFailure], "Hermetic app-web setup and cleanup failed");
    }
    throw error;
  }
}
