import { loopbackFetch } from "./server-fetch.js";

const LOCAL_MODELS_URL = "http://localhost:8791/models";

// Self-hosted fork: there is deliberately no default remote model catalog.
// This previously fell back to PRODUCTION_MODELS_URL (models.openworklabs.com)
// and, worse, the caller injected the result into the engine's environment as
// OPENCODE_MODELS_URL - which re-enabled the catalog fetch that
// OPENCODE_DISABLE_MODELS_FETCH=1 was supposed to suppress. Returning undefined
// means the variable is never set and OpenCode keeps its bundled catalog.
// Set OPENCODE_MODELS_URL to run your own catalog.

type ResolveOpencodeModelsUrlOptions = {
  env?: NodeJS.ProcessEnv;
  fetchModels?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
};

export async function resolveOpencodeModelsUrl(
  options: ResolveOpencodeModelsUrlOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const override = env.OPENCODE_MODELS_URL?.trim();
  if (override) return override;

  if (env.OPENWORK_DEV_MODE === "1") {
    try {
      const response = await (options.fetchModels ?? loopbackFetch)(`${LOCAL_MODELS_URL}/api.json`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return LOCAL_MODELS_URL;
    } catch {
      // A standalone dev session does not run the local inference stack.
    }
  }

  return undefined;
}
