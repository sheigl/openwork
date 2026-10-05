import { DESKTOP_FREE_MODEL_ID, DESKTOP_FREE_PROVIDER_ID } from "@openwork/free-auto";

export const ANONYMOUS_INFERENCE_PROVIDER_ID = DESKTOP_FREE_PROVIDER_ID;
export const ANONYMOUS_INFERENCE_MODEL_ID = DESKTOP_FREE_MODEL_ID;
export const ANONYMOUS_INFERENCE_PROVIDER_NAME = "OpenWork Models (Free)";
export const LOCAL_ROUTE_PREFIX = "/anonymous-inference/v1";
export const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
export const ERROR_BODY_LIMIT = 64 * 1024;
export const SESSION_TIMEOUT_MS = 10_000;
export const REQUEST_LIFETIME_MS = 5 * 60_000;
export const MEMBER_CREDENTIAL_CACHE_MS = 5 * 60_000;
export const STATUS_CACHE_MS = 10_000;
export const FAILURE_CACHE_MS = 30_000;
export const FAILURE_CACHE_LIMIT = 64;
export const HEADER_TIMEOUT_MS = 30_000;
export const REQUEST_BODY_TIMEOUT_MS = 15_000;

// This fork is self-hosted: there is no bundled inference origin. The relay is
// disabled unless OPENWORK_ENABLE_FREE_INFERENCE=1 is set (see readRelaySettings),
// so nothing ever dials this. It exists only to keep `origin` a string.
const UNCONFIGURED_ORIGIN = "http://127.0.0.1:0";

export function resolveAnonymousInferenceOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  // Previously fell back to https://inference.openworklabs.com, which routed
  // every model request through OpenWork's cloud.
  const configured = environment.OPENWORK_FREE_INFERENCE_ORIGIN?.trim();
  if (!configured) return UNCONFIGURED_ORIGIN;
  const url = new URL(configured);
  const local = (environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test")
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("OPENWORK_FREE_INFERENCE_ORIGIN must be an HTTPS origin (loopback HTTP is development-only).");
  }
  return url.origin;
}

export type RelaySettings = {
  origin: string;
  /** Loopback Den is allowed only for developer and test runs. */
  allowLocalDen: boolean;
  /** An environment switch can turn free Auto off for this device. */
  disabledByEnvironment: boolean;
};
export function readRelaySettings(environment: NodeJS.ProcessEnv = process.env): RelaySettings {
  const truthy = (value: string | undefined) => /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
  // Self-hosted fork: the free-inference relay reaches out to an external
  // origin, so it is opt-in. Set OPENWORK_ENABLE_FREE_INFERENCE=1 and point
  // OPENWORK_FREE_INFERENCE_ORIGIN at your own gateway to turn it on.
  const explicitlyEnabled = truthy(environment.OPENWORK_ENABLE_FREE_INFERENCE);
  const switchedOff = [
    environment.OPENWORK_DISABLE_FREE_INFERENCE,
    environment.OPENWORK_DISABLE_HOSTED_MODELS,
    environment.VITE_DISABLE_OPENWORK_MODELS,
  ].some(truthy);
  return {
    origin: resolveAnonymousInferenceOrigin(environment),
    allowLocalDen: environment.OPENWORK_DEV_MODE === "1" || environment.NODE_ENV === "test",
    disabledByEnvironment: !explicitlyEnabled || switchedOff,
  };
}
