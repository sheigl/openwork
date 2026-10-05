/**
 * Self-hosted fork: OpenWork's PostHog project key is deliberately not baked
 * in. With no key the analytics module short-circuits on every send, so nothing
 * is ever transmitted to us.i.posthog.com. Set VITE_OPENWORK_POSTHOG_KEY to your
 * own project key to turn analytics back on.
 */
export const DEFAULT_POSTHOG_KEY = "";

/**
 * Resolve the PostHog project key. `raw` is VITE_OPENWORK_POSTHOG_KEY.
 * Unset stays silent in every build. An explicit string is used after trim; an
 * empty string disables analytics in any build.
 */
export function resolvePosthogKey(raw: unknown, isDev: boolean): string {
  if (typeof raw === "string") return raw.trim(); // explicit value wins; "" disables
  return isDev ? "" : DEFAULT_POSTHOG_KEY;
}
