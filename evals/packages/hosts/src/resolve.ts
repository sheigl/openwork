import { fileURLToPath } from "node:url";
import { createLocalHost } from "./local.ts";
import type { DisposableHost, Host } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export async function resolveHost(_env: NodeJS.ProcessEnv = process.env): Promise<Host & AsyncDisposable> {
  return createLocalHost({ repoRoot: REPO_ROOT, log: () => undefined });
}

/**
 * PLACEMENT, stated rather than inferred.
 *
 * `resolveHost()` inherits its host from the environment, so a whole process
 * gets one host. A spec that needs the app and the browser in different
 * places — or two desktops on different machines — cannot say so. These
 * factories name a placement, and `desktop({ host })` / `chrome({ host })`
 * take it, so a spec declares its topology instead of inheriting it from
 * the environment.
 */
export function localHost(): DisposableHost {
  return createLocalHost({ repoRoot: REPO_ROOT, log: () => undefined });
}
