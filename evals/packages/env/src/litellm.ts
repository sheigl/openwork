import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { progress, trackResource } from "@openwork/world";
import type { Server, ServerResponse } from "node:http";
import { SkipError } from "./needs.ts";

const IMAGE = "ghcr.io/berriai/litellm:v1.97.0@sha256:468c25f35f3e5ec4e414974f00deab93337b1b4d9953cabcfd3722e59415f834";
const POSTGRES_IMAGE = "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
const COMMAND_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 90_000;
const DATABASE_STARTUP_TIMEOUT_MS = 300_000;
const POSTGRES_STARTUP_TIMEOUT_MS = 90_000;
const steps = progress();
const DEFAULT_MAX_INPUT_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;



export interface LiteLlmUpstreamRequest {
  sequence: number;
  model: string;
  tokenId: string;
  bodyText: string;
}

export interface LiteLlmHandle extends AsyncDisposable {
  baseUrl: string;
  apiKey: string;
  upstreamKey: string;
  tokenId(key: string): string;
  checkpoint(): Promise<number>;
  waitForUpstreamRequest(input: { after: number; model: string; key: string; timeoutMs: number }): Promise<LiteLlmUpstreamRequest>;
  upstreamRequests(input: { after: number }): Promise<LiteLlmUpstreamRequest[]>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface WitnessState {
  requests: LiteLlmUpstreamRequest[];
  sequence: number;
}

interface LiteLlmSecrets {
  masterKey: string;
  upstreamKey: string;
  controlKey: string;
}

interface HandleInput extends LiteLlmSecrets {
  baseUrl: string;
  controlUrl: string;
  fetchImpl: typeof fetch;
  redactedSecrets?: string[];
  dispose(): Promise<void>;
}

function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1_024 * 1_024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function tokenId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function bearerToken(value: string | undefined): string {
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

function redactedError(error: unknown, secrets: string[]): Error {
  return new Error(redact(messageText(error), secrets));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function validCursor(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("LiteLLM sequence cursor must be a non-negative integer.");
  return value;
}

function parseUpstreamRequest(value: unknown): LiteLlmUpstreamRequest {
  if (!isRecord(value)
    || typeof value.sequence !== "number"
    || !Number.isInteger(value.sequence)
    || value.sequence < 1
    || typeof value.model !== "string"
    || typeof value.tokenId !== "string"
    || typeof value.bodyText !== "string") {
    throw new Error("LiteLLM witness request response has an invalid shape.");
  }
  return {
    sequence: value.sequence,
    model: value.model,
    tokenId: value.tokenId,
    bodyText: value.bodyText,
  };
}

function parseHealth(value: unknown): number {
  if (!isRecord(value)
    || value.ok !== true
    || typeof value.sequence !== "number"
    || !Number.isInteger(value.sequence)
    || value.sequence < 0) {
    throw new Error("LiteLLM witness health response has an invalid shape.");
  }
  return value.sequence;
}

function parseRequests(value: unknown, after: number): LiteLlmUpstreamRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) {
    throw new Error("LiteLLM witness requests response has an invalid shape.");
  }
  return value.requests.map(parseUpstreamRequest).filter((request) => request.sequence > after);
}

async function controlJson(fetchImpl: typeof fetch, controlUrl: string, controlKey: string, path: string): Promise<unknown> {
  const response = await fetchImpl(`${controlUrl}${path}`, {
    headers: { authorization: `Bearer ${controlKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`LiteLLM witness control ${path} failed with HTTP ${response.status}.`);
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    throw new Error(`LiteLLM witness control ${path} returned invalid JSON.`);
  }
}

function makeHandle(input: HandleInput): LiteLlmHandle {
  const secrets = [input.masterKey, input.upstreamKey, input.controlKey, ...(input.redactedSecrets ?? [])];
  let disposed = false;
  const upstreamRequests = async ({ after }: { after: number }): Promise<LiteLlmUpstreamRequest[]> => {
    const cursor = validCursor(after);
    try {
      return parseRequests(
        await controlJson(input.fetchImpl, input.controlUrl, input.controlKey, `/__openwork_litellm/requests?after=${cursor}`),
        cursor,
      );
    } catch (error) {
      throw redactedError(error, secrets);
    }
  };
  return {
    baseUrl: input.baseUrl,
    apiKey: input.masterKey,
    upstreamKey: input.upstreamKey,
    tokenId,
    async checkpoint(): Promise<number> {
      try {
        return parseHealth(await controlJson(
          input.fetchImpl,
          input.controlUrl,
          input.controlKey,
          "/__openwork_litellm/health",
        ));
      } catch (error) {
        throw redactedError(error, secrets);
      }
    },
    upstreamRequests,
    async waitForUpstreamRequest({ after, model, key, timeoutMs }) {
      const cursor = validCursor(after);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("LiteLLM request timeout must be positive.");
      const deadline = Date.now() + timeoutMs;
      const expectedTokenId = tokenId(key);
      let observed: LiteLlmUpstreamRequest[] = [];
      while (Date.now() < deadline) {
        observed = await upstreamRequests({ after: cursor });
        const found = observed.find((request) => request.model === model && request.tokenId === expectedTokenId);
        if (found) return found;
        await delay(100);
      }
      const summary = observed.map((request) => ({
        sequence: request.sequence,
        model: request.model,
        tokenId: request.tokenId,
      }));
      throw new Error(`Upstream did not receive model ${model} with token fingerprint ${expectedTokenId}. Observed: ${JSON.stringify(summary)}`);
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      try {
        await input.dispose();
        disposed = true;
      } catch (error) {
        throw redactedError(error, secrets);
      }
    },
  };
}

function startWitness(
  modelId: string,
  reply: string,
  upstreamTokenId: string,
  controlTokenId: string,
  state: WitnessState,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      writeJson(response, 200, { object: "list", data: [{ id: modelId, object: "model", owned_by: "openwork-testkit" }] });
      return;
    }
    if (request.method === "GET"
      && (url.pathname === "/__openwork_litellm/health" || url.pathname === "/__openwork_litellm/requests")) {
      if (tokenId(bearerToken(request.headers.authorization)) !== controlTokenId) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/__openwork_litellm/health") {
        writeJson(response, 200, { ok: true, sequence: state.sequence });
        return;
      }
      const afterText = url.searchParams.get("after") ?? "0";
      const after = Number(afterText);
      if (!Number.isInteger(after) || after < 0) {
        writeJson(response, 400, { error: "invalid cursor" });
        return;
      }
      writeJson(response, 200, {
        sequence: state.sequence,
        requests: state.requests.filter((entry) => entry.sequence > after),
      });
      return;
    }
    if (request.method !== "POST" || (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions")) {
      writeJson(response, 404, { error: { message: "not found" } });
      return;
    }

    let bodyText = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { bodyText += chunk; });
    request.on("end", () => {
      let body: unknown = null;
      try { body = JSON.parse(bodyText); } catch { body = null; }
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      const requestTokenId = tokenId(bearerToken(request.headers.authorization));
      state.sequence += 1;
      const sequence = state.sequence;
      state.requests.push({ sequence, model, tokenId: requestTokenId, bodyText });
      if (requestTokenId !== upstreamTokenId) {
        writeJson(response, 401, { error: { message: "unauthorized" } });
        return;
      }
      const id = `chatcmpl-openwork-${sequence}`;
      if (isRecord(body) && body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      writeJson(response, 200, {
        id,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("LiteLLM upstream witness did not bind a TCP port."));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function liteLlmConfig(
  modelId: string,
  apiBase: string,
  masterKey: string,
  upstreamKey: string,
  maxInputTokens: number,
  maxOutputTokens: number,
): string {
  return JSON.stringify({
    model_list: [{
      model_name: modelId,
      litellm_params: {
        model: `openai/${modelId}`,
        api_base: apiBase,
        api_key: upstreamKey,
      },
      model_info: {
        max_input_tokens: maxInputTokens,
        max_output_tokens: maxOutputTokens,
        supports_function_calling: true,
        supports_vision: true,
        supports_reasoning: false,
        supports_response_schema: true,
        supported_openai_params: ["temperature", "tools", "response_format"],
      },
    }],
    general_settings: { master_key: masterKey },
  }, null, 2);
}

function positiveTokenLimit(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a finite positive number.`);
  return value;
}

async function mappedPort(container: string): Promise<number> {
  const result = await run("docker", ["port", container, "4000/tcp"], 10_000);
  const match = result.stdout.match(/:(\d+)\s*$/m);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`docker port returned an invalid mapping: ${result.stdout.trim()}`);
  return port;
}

async function mappedPostgresPort(container: string): Promise<number> {
  const result = await run("docker", ["port", container, "5432/tcp"], 10_000);
  const match = result.stdout.match(/:(\d+)\s*$/m);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`docker port returned an invalid Postgres mapping: ${result.stdout.trim()}`);
  return port;
}

function modelIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []);
}

async function waitForLocalProxy(container: string, apiKey: string, modelId: string): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let port = 0;
  let last = "proxy not queried";
  while (Date.now() < deadline) {
    try {
      port ||= await mappedPort(container);
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const body: unknown = await response.json();
      if (response.ok && modelIds(body).includes(modelId)) return port;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`LiteLLM did not expose model ${modelId} within ${STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function waitForLocalDatabaseProxy(container: string, apiKey: string, modelId: string): Promise<number> {
  const deadline = Date.now() + DATABASE_STARTUP_TIMEOUT_MS;
  let port = 0;
  let modelsReady = false;
  let last = "proxy not queried";
  while (Date.now() < deadline) {
    try {
      port ||= await mappedPort(container);
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      const body: unknown = await response.json();
      if (response.ok && modelIds(body).includes(modelId)) {
        modelsReady = true;
        break;
      }
      last = `models HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(1_000);
  }
  if (!port || !modelsReady) {
    throw new Error(`LiteLLM did not expose model ${modelId} within ${DATABASE_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
  }

  const keyManagementDeadline = Date.now() + DATABASE_STARTUP_TIMEOUT_MS;
  while (Date.now() < keyManagementDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/key/generate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ models: [modelId], duration: "5m" }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return port;
      last = `key management HTTP ${response.status}`;
    } catch (error) {
      last = messageText(error);
    }
    await delay(1_000);
  }
  throw new Error(`LiteLLM key management did not become ready within ${DATABASE_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function waitForPostgres(container: string): Promise<void> {
  const deadline = Date.now() + POSTGRES_STARTUP_TIMEOUT_MS;
  let last = "pg_isready not attempted";
  while (Date.now() < deadline) {
    try {
      await run("docker", ["exec", container, "pg_isready", "--username", "postgres", "--dbname", "litellm"], 5_000);
      return;
    } catch (error) {
      last = messageText(error);
    }
    await delay(500);
  }
  throw new Error(`LiteLLM Postgres did not become ready within ${POSTGRES_STARTUP_TIMEOUT_MS}ms (last observation: ${last}).`);
}

async function startLocalLiteLlm(
  input: {
    modelId: string;
    reply: string;
    database?: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
  },
  secrets: LiteLlmSecrets,
): Promise<LiteLlmHandle> {
  try {
    await run("docker", ["info"], 15_000);
  } catch {
    throw new SkipError("Docker daemon is unavailable");
  }

  const state: WitnessState = { requests: [], sequence: 0 };
  const container = `openwork-litellm-${randomBytes(8).toString("hex")}`;
  const postgresContainer = input.database ? `openwork-litellm-postgres-${randomBytes(8).toString("hex")}` : "";
  const postgresPassword = input.database ? randomBytes(32).toString("hex") : "";
  let root = "";
  let witness: Server | null = null;
  let gatewayStep: ReturnType<typeof steps.step> | undefined;
  try {
    const witnessStep = steps.step("litellm-witness", "LiteLLM witness");
    const startedWitness = await startWitness(
      input.modelId,
      input.reply,
      tokenId(secrets.upstreamKey),
      tokenId(secrets.controlKey),
      state,
    );
    await witnessStep.ok(String(startedWitness.port));
    witness = startedWitness.server;
    root = await realpath(await mkdtemp(join(tmpdir(), "openwork-litellm-")));
    await trackResource({ kind: "tmpdir", id: root, label: "litellm-config" });
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      liteLlmConfig(
        input.modelId,
        `http://host.docker.internal:${startedWitness.port}/v1`,
        secrets.masterKey,
        secrets.upstreamKey,
        input.maxInputTokens,
        input.maxOutputTokens,
      ),
      { mode: 0o600 },
    );
    let postgresPort = 0;
    if (input.database) {
      const postgresStep = steps.step("litellm-postgres", "LiteLLM Postgres");
      await run("docker", [
        "create", "--name", postgresContainer,
        "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
        "--env", "POSTGRES_DB=litellm",
        "--publish", "127.0.0.1::5432",
        POSTGRES_IMAGE,
      ]);
      await trackResource({ kind: "docker", id: postgresContainer, label: "litellm-postgres" });
      await run("docker", ["start", postgresContainer], 30_000);
      postgresPort = await mappedPostgresPort(postgresContainer);
      await waitForPostgres(postgresContainer);
      await postgresStep.ok();
    }
    const createArgs = input.database
      ? [
          "create", "--name", container,
          "--add-host", "host.docker.internal:host-gateway",
          "--publish", "127.0.0.1::4000",
          "--env", `DATABASE_URL=postgresql://postgres:${postgresPassword}@host.docker.internal:${postgresPort}/litellm`,
          IMAGE, "--config", "/app/config.json", "--port", "4000",
        ]
      : [
          "create", "--name", container,
          "--add-host", "host.docker.internal:host-gateway",
          "--publish", "127.0.0.1::4000",
          IMAGE, "--config", "/app/config.json", "--port", "4000",
        ];
    gatewayStep = steps.step("litellm", "LiteLLM gateway");
    await run("docker", createArgs);
    await trackResource({ kind: "docker", id: container, label: "litellm" });
    await run("docker", ["cp", configPath, `${container}:/app/config.json`], 30_000);
    await run("docker", ["start", container], 30_000);
    const port = input.database
      ? await waitForLocalDatabaseProxy(container, secrets.masterKey, input.modelId)
      : await waitForLocalProxy(container, secrets.masterKey, input.modelId);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await gatewayStep.ok(baseUrl);
    let placementDisposed = false;
    return makeHandle({
      ...secrets,
      baseUrl,
      controlUrl: `http://127.0.0.1:${startedWitness.port}`,
      fetchImpl: fetch,
      redactedSecrets: input.database ? [postgresPassword] : undefined,
      async dispose(): Promise<void> {
        if (placementDisposed) return;
        await run("docker", ["rm", "--force", "--volumes", container], 20_000).catch(() => undefined);
        if (input.database) {
          await run("docker", ["rm", "--force", "--volumes", postgresContainer], 20_000).catch(() => undefined);
        }
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          closeServer(startedWitness.server),
        ]);
        placementDisposed = true;
      },
    });
  } catch (error) {
    await gatewayStep?.fail(messageText(error));
    const logs = await run("docker", ["logs", container], 10_000).then((result) => result.stdout + result.stderr, () => "");
    const postgresLogs = input.database
      ? await run("docker", ["logs", postgresContainer], 10_000).then((result) => result.stdout + result.stderr, () => "")
      : "";
    await run("docker", ["rm", "--force", "--volumes", container], 20_000).catch(() => undefined);
    if (input.database) {
      await run("docker", ["rm", "--force", "--volumes", postgresContainer], 20_000).catch(() => undefined);
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (witness) await closeServer(witness).catch(() => undefined);
    throw redactedError(
      `${messageText(error)}${logs ? `\nDocker logs:\n${logs.slice(-4_000)}` : ""}${postgresLogs ? `\nPostgres logs:\n${postgresLogs.slice(-4_000)}` : ""}`,
      [secrets.masterKey, secrets.upstreamKey, secrets.controlKey, ...(input.database ? [postgresPassword] : [])],
    );
  }
}

export async function liteLlm(input: {
  modelId: string;
  reply: string;
  database?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}): Promise<LiteLlmHandle> {
  const secrets: LiteLlmSecrets = {
    masterKey: `sk-openwork-master-${randomBytes(24).toString("hex")}`,
    upstreamKey: `sk-openwork-upstream-${randomBytes(24).toString("hex")}`,
    controlKey: `sk-openwork-control-${randomBytes(24).toString("hex")}`,
  };
  return startLocalLiteLlm(
    {
      modelId: input.modelId,
      reply: input.reply,
      database: input.database,
      maxInputTokens: positiveTokenLimit(input.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS, "maxInputTokens"),
      maxOutputTokens: positiveTokenLimit(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, "maxOutputTokens"),
    },
    secrets,
  );
}


