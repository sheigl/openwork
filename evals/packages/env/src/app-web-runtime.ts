import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessWeb, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { resolveEvalEngine, type EvalEngine } from "./eval-engine.ts";
import { seedSyntheticPreactivatedDen } from "./app-web-bootstrap.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const EXECUTABLE_ENV_KEYS = ["PATH", "PNPM_HOME", "TMPDIR", "SHELL", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "npm_execpath", "npm_node_execpath"];

export interface AppWebRuntime {
  webUrl: string;
  openworkUrl: string;
  runtimeDirectory: string;
  fixtureRoot: string;
  stop(): Promise<void>;
}

export interface AppWebRuntimeOptions {
  engine?: EvalEngine;
  den?: { apiUrl: string; webUrl: string };
  webPort?: number;
  emptyWorkspace?: boolean;
  syntheticPreactivatedDenOrigin?: string;
  env?: Record<string, string>;
  browserHostSuffix?: string;
}

function executableEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of EXECUTABLE_ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

export function isolatedRuntimeEnvironment(root: string, engine: EvalEngine = resolveEvalEngine()): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const data = join(root, "data");
  const config = join(root, "config");
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(root, "cache"),
    // Fresh app instances must not rewrite another Vite server's dependency
    // cache while its browser is importing modules.
    OPENWORK_VITE_CACHE_DIR: join(root, "cache", "vite"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: join(root, "state"),
    OPENWORK_DATA_DIR: join(data, "openwork"),
    OPENWORK_ENV_STORE: join(config, "openwork", "env.json"),
    OPENWORK_SERVER_STATE_PATH: join(data, "openwork", "server-state.json"),
    OPENWORK_SERVER_TOKEN_STORE_PATH: join(data, "openwork", "server-tokens.json"),
    OPENCODE_CONFIG_DIR: join(config, "opencode"),
    OPENCODE_DB: join(data, "opencode", "opencode.db"),
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "0",
    OPENWORK_ENGINE_V2_PREVIEW: engine === "v2" ? "1" : "0",
    OPENWORK_PORT: "0",
    OPENWORK_WEB_PORT: "0",
    OPENWORK_REMOTE_ACCESS: "0",
    HOST: "127.0.0.1",
    VITE_HOST: "127.0.0.1",
    VITE_DISABLE_OPENWORK_MODELS: "1",
    VITE_OPENWORK_POSTHOG_KEY: "",
    VITE_OPENWORK_SENTRY_DSN: "",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export function appWebDenEnvironment(den?: AppWebRuntimeOptions["den"]): Record<string, string> {
  if (!den) return {};
  for (const address of [den.apiUrl, den.webUrl]) {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("App-web Den addresses must be HTTP(S) URLs without credentials, query or fragment");
    }
  }
  return { VITE_DEN_API_BASE_URL: den.apiUrl, VITE_DEN_BASE_URL: den.webUrl };
}

function runtimeDirectories(root: string): string[] {
  return ["home", "cache", "config/openwork", "config/opencode", "data/openwork", "data/opencode", "state"].map((path) => join(root, path));
}

export async function startLocalRuntime(worldName: string, workspaceRoot: string, options: AppWebRuntimeOptions = {}): Promise<AppWebRuntime> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openwork-eval-app-web-"));
  const runtimeDirectory = resolveHeadlessWorldRuntimePaths(REPO_ROOT, worldName).directory;
  try {
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), ...runtimeDirectories(fixtureRoot).map((path) => mkdir(path, { recursive: true }))]);
    const bootstrapEnv = await seedSyntheticPreactivatedDen(fixtureRoot, options.syntheticPreactivatedDenOrigin);
    const runtime = await launchHeadlessWeb({
      repoRoot: REPO_ROOT,
      name: worldName,
      state: "isolated",
      workspace: workspaceRoot,
      emptyWorkspace: options.emptyWorkspace,
      browserHostSuffix: options.browserHostSuffix,
      env: { ...executableEnvironment(process.env), ...isolatedRuntimeEnvironment(fixtureRoot, options.engine), ...options.env, ...(options.webPort ? { OPENWORK_WEB_PORT: String(options.webPort) } : {}), ...appWebDenEnvironment(options.den), ...bootstrapEnv },
    });
    return { webUrl: runtime.manifest.webUrl, openworkUrl: runtime.manifest.openworkUrl, runtimeDirectory, fixtureRoot, stop: () => runtime.stop() };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

