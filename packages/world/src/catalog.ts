/**
 * What each maintained world accepts on each target, and ready-to-run commands
 * by intent. `pnpm world help <name> --json` publishes this so an agent can
 * choose a world, placement, seed and source in one call instead of reading the
 * recipes. `world up` composes `--source`/`--seed` from the same entries. The
 * world scripts still enforce every rule; tests keep this catalog in step with
 * them and parse every example command.
 */

import type { SourceKind } from "./source.ts";

/** A `--source` spec kind as typed on the command line: `ref:` resolves to a `sha` before launch. */
export type GuideSourceKind = SourceKind | "ref";

export interface WorldTargetGuide {
  /** A `supportedTargets` entry, for example `local/host`. */
  target: string;
  /** Seeds accepted on this target; empty when the world takes no seed. */
  seeds: readonly string[];
  /** Source kinds accepted on this target. */
  sources: readonly GuideSourceKind[];
  /** What an omitted `--source` means here. Absent when a source is required. */
  defaultSource?: string;
  note?: string;
}

export interface WorldExample {
  intent: string;
  command: string;
}

export interface WorldGuide {
  /** How `world up` composes `--source`/`--seed` for this world. */
  family: "preview" | "web";
  /** `--source` components; `*` is the unnamed default component. */
  components: readonly string[];
  targets: readonly WorldTargetGuide[];
  examples: readonly WorldExample[];
  caveats?: readonly string[];
}

/** The default source for local worlds: this checkout, uncommitted changes included. */
export const DEFAULT_DEV_SOURCE = "local: this checkout, including uncommitted changes";
const LOCAL = "local: this checkout, including uncommitted changes";
const UP = "pnpm world up";
const DETACH = "--detach --timeout 600000";

/** What each seed prepares. Seeds are named scenarios, not arbitrary fixtures. */
export const SEED_MEANINGS: Readonly<Record<string, string>> = {
  blank: "Exact published release bytes with a completely blank, unseeded profile.",
};

/** Placeholders used in example commands. */
export const EXAMPLE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  "<stage>": "a unique name for this preview, for example pr-1234 or alpha-0930; reuse it to reopen the same preview",
  "<full-pushed-sha>": "a full 40-character commit SHA that is pushed to origin",
  "<x.y.z>": "an exact published desktop version, for example 0.18.52",
  "<distribution>": "public, cloud or enterprise",
};

export const WORLD_GUIDES: Readonly<Record<string, WorldGuide>> = {
  "dev-app-web": {
    family: "web",
    components: ["*"],
    targets: [
      { target: "local/host", seeds: [], sources: ["local"], defaultSource: LOCAL,
        note: "The only placement left in this fork. It always runs this working tree; there is no remote sandbox to select." },
    ],
    examples: [
      { intent: "This checkout's server plus web UI, state kept between runs", command: `${UP} dev-app-web --detach` },
      { intent: "The same, in the foreground", command: `${UP} dev-app-web` },
    ],
    caveats: [
      "Writes tmp/headless-server.json and never reads ~/.config/openwork/server.json.",
      "Listens on loopback only; it authorizes whatever reaches the port, so do not publish it.",
    ],
  },
  "live-app-web": {
    family: "web",
    components: ["*"],
    targets: [
      { target: "local/macos", seeds: [], sources: ["local"], defaultSource: LOCAL,
        note: "Shares your installed production desktop state, so it needs the explicit opt-in below." },
    ],
    examples: [
      { intent: "Source web app against your installed production state", command: `${UP} live-app-web -- --allow-shared-state` },
    ],
    caveats: ["Mutates real installed state. Requires --allow-shared-state after `--`."],
  },
  "live-desktop": {
    family: "preview",
    components: ["*"],
    targets: [
      { target: "local/macos", seeds: ["blank"], sources: ["local"], defaultSource: LOCAL,
        note: "Shares your installed production state, so it needs the explicit opt-in below." },
    ],
    examples: [
      { intent: "Source desktop app against your installed production state", command: `${UP} live-desktop -- --allow-shared-state` },
    ],
    caveats: ["Mutates real installed state. Requires --allow-shared-state after `--`."],
  },
};

export function guideSeeds(guide: WorldGuide): string[] {
  return [...new Set(guide.targets.flatMap((target) => target.seeds))];
}
