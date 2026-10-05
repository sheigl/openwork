# OpenWork (self-hosted fork)

OpenWork is a desktop app for macOS, Windows, and Linux where AI agents do real work on your own files. It is built on [OpenCode](https://opencode.ai), works with any model — 50+ providers, your own API keys, or local models via Ollama — and lets teams share skills and MCP servers.

> **This is a self-hosted-only fork of OpenWork.**
>
> OpenWork's hosted control plane has been **removed from this repository**. That means:
>
> - There is no `ee/` directory. OpenWork Den (the organization control plane, its MCP gateway, and its hosted inference) is gone, along with the generated Den SDK client and the cloud deployment artifacts (Helm chart, AWS ECS Terraform module, Den Dockerfiles, Daytona cloud sandboxes).
> - **Nothing phones home by default.** There is no baked-in model catalog, no PostHog analytics key, no default control plane, and no hosted feedback or documentation link. The server does not contact OpenWork or `openworklabs.com` unless you configure it to.
> - Free hosted inference is **opt-in**: set `OPENWORK_ENABLE_FREE_INFERENCE=1` *and* point it at your own origin. Unconfigured, it resolves to an inert sentinel and never connects.
> - The whole repository is **MIT**. The previous directory-split license is obsolete.

Run your own `openwork-server`. Point it at your own model provider, your own MCP servers, and your own skills. Nothing is required from us.

## Why OpenWork instead of Claude Cowork

- **Free and open source.** MIT-licensed throughout; no OpenWork account is required, and no account is even possible.
- **Any model.** Bring your own API key, sign in with ChatGPT, or run local models through Ollama or any OpenAI-compatible server.
- **Runs on macOS, Windows, and Linux** as a desktop app — not a CLI.
- **Your files stay local.** There is no cloud to opt out of.

## Install with your AI agent

Already use an AI agent? Copy this prompt and paste it into Claude Code, Cursor, Codex, ChatGPT, or any agent that can run commands on your computer.

```text
Install OpenWork on my computer, set up my first workspace, and open it ready to use.
```

1. Installs OpenWork
2. Creates your workspace
3. Opens it ready to run

## Running the server yourself

`openwork-server` is the headless backend. It serves the web UI and the local agent runtime.

```bash
npm install -g openwork-server
openwork-server
```

It writes its configuration to `~/.config/openwork` and listens on `127.0.0.1:8787` unless told otherwise. **Do not bind it to a public interface.** The server injects a valid client token into the page it serves for any `Host` header, so anything that can reach the port is signed in. Keep it on loopback, or put it behind your own authenticating reverse proxy on a trusted network.

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `OPENCODE_MODELS_URL` | Model catalog URL. Unset means "no catalog" — the key is omitted entirely rather than defaulting to a remote mirror. |
| `OPENWORK_ENABLE_FREE_INFERENCE` | Set to `1` to enable the free-inference route. Off by default. |
| `OPENWORK_FREE_INFERENCE_ORIGIN` | Origin the free-inference route talks to. Required when the route is enabled. |

## Licensing

Everything in this repository is MIT — see [LICENSE](./LICENSE). The previous split that put `ee/` under a source-available OpenWork EE License no longer applies, because `ee/` was removed.

Versions released upstream before that license split was adopted remain under their original license (FSL-1.1-MIT).

## Getting started (contributors)

The fastest path from a fresh clone to a running dev build.

### Prerequisites

- **Node 24** — pinned in [`.nvmrc`](./.nvmrc) (`nvm use` picks it up).
- **pnpm 11** — pinned in `package.json` (`packageManager`); run `corepack enable` to use the pinned version automatically. Never use npm or yarn.
- **Git with DCO sign-off** — every commit needs a `Signed-off-by` trailer (`git commit -s`). See [CONTRIBUTING.md](./CONTRIBUTING.md).

### First run

```bash
git clone https://github.com/sheigl/openwork.git
cd openwork
corepack enable
pnpm install
pnpm dev   # launches the Electron desktop app with hot reload
```

### Repository layout

| Path | What lives there |
| --- | --- |
| `apps/` | the desktop app: React UI (`apps/app`), Electron shell (`apps/desktop`), and `openwork-server` (`apps/server`) |
| `packages/` | shared core packages |
| `evals/` | executable test specs built on `@openwork/testkit` — see [`evals/README.md`](./evals/README.md) |
| `worlds/` | declarative dev/test environment definitions for `pnpm world` |
| `docs/` | operator, feature, and release docs |
| `.opencode/skills/` | repository agent skills |

### Verifying there is no cloud egress

The repository carries a machine-readable egress allowlist and an auditor that checks it against the actual source:

```bash
node scripts/check-outbound-access.mjs
```

It scans the shipped client surfaces (`apps/server/src`, `apps/app/src`, `apps/desktop/electron`, `packages/openwork-bootstrap/bin`) for external hosts and fails if the manifest in [`docs/enterprise/outbound-access.json`](./docs/enterprise/outbound-access.json) has drifted from reality. When you add an outbound request, add the host to the manifest with its purpose, blocked effect, and override.

### Testing

All executable coverage lives in `evals/specs/**/*.test.ts`; app-driving journeys use `.e2e.test.ts`.

```bash
pnpm --dir evals install --frozen-lockfile   # once
pnpm evals:pr specs/<name>.test.ts           # app-less PR-lane spec
pnpm evals:e2e <name> --local                # app-driving E2E journey, run locally
```

Runtime-observable changes need test evidence on the PR. `AGENTS.md` and [`evals/README.md`](./evals/README.md) describe the verification contract and vocabulary.

### Sending a pull request

1. Branch from `dev` (the default branch) and open your PR against `dev`.
2. Sign off every commit: `git commit -s`.
3. Keep the diff as small as possible, and include or update test evidence for runtime-observable changes.
4. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO rules.

## Local development

For one checkout, keep using `pnpm dev`; with no extra environment variables it reuses the existing shared dev profile.

To run multiple git worktrees at once, use:

```bash
pnpm dev:worktree
```

That sets `OPENWORK_DEV_PROFILE=auto`, derives a stable profile name from the worktree path, lets Electron choose a free CDP port, and asks Vite for a free dev-server port. You can also choose a named profile, for example `OPENWORK_DEV_PROFILE=my-feature OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0 PORT=0 pnpm dev`.

`dev:worktree` also defaults `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=1`. A brand-new profile has no stored credentials, so on macOS the real keychain prompts as soon as Chromium persists an authenticated cookie, and that modal blocks Electron's main loop until it is dismissed. Set `OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=0` if you specifically want the system keychain in an isolated profile.

Dev startup prints a banner like `[openwork] dev profile=... cdp=http://127.0.0.1:9823`; use it to find the profile directory and pass the CDP URL to local tooling.

If a second instance cannot get the profile lock it now says so and exits, instead of lingering with an open CDP port and no window.

### Headless web (no Electron)

To run the OpenWork UI in a browser against a local `openwork-server` (no desktop shell):

```bash
pnpm world up dev-app-web --detach
```

`pnpm dev:headless-web` is a compatibility alias for the same script. The alias
remains foreground by default and accepts `--detach`; `world up` is foreground
unless `--detach` is explicit.

This is an isolated launcher:

- Writes `tmp/headless-server.json` and never reads `~/.config/openwork/server.json`
- Authorizes the chosen workspace root automatically, and merges (never rewrites) that config on relaunch, so workspaces you add through the UI survive `--replace`
- Starts Vite + `openwork-server` with a stable owner bearer forced into the UI. Crash-restarts keep open tabs working. The privileged host token stays on the server process and is never inlined into the Vite bundle.
- Publishes an owner-only runtime manifest at `tmp/dev-headless-web.json` (`0600`), and allows browser calls to the local server only from the web app's own origins — not every site you visit
- Uses stable ports by default (web `5178`, server `8778`; falls back to free ports when taken, override with `OPENWORK_WEB_PORT` / `OPENWORK_PORT`)
- Is single-instance as `dev-app-web`; stop it with `pnpm world down dev-app-web` before launching it again
- Keeps Vite and the backend under one script lifecycle, so either sibling exiting stops the other instead of leaving an orphan
- In detached mode, waits for health, prints non-secret outputs and receipt/log paths, and exits

Script-specific options must follow `--`:

```bash
pnpm world up dev-app-web --detach -- --replace
pnpm world up dev-app-web --detach -- --replace --keep-tokens
```

`--replace` restarts the headless runtime with fresh tokens; add
`--keep-tokens` to retain the previous tokens. `--rotate-tokens` is also
accepted by this script. These are not generic `world` options.

There is no sign-in step in this fork: the control plane that hosted it is gone,
so the launcher authorizes the workspace root directly.

The other checked-in scripts include `worlds/live-app-web.ts` and
`worlds/live-desktop.ts`. Both intentionally share installed production
state and require their script-specific opt-in after `--`, for example
`pnpm world up live-desktop -- --allow-shared-state`. List scripts and
running receipts with `pnpm world list`. The headless
production world is hard-limited to loopback; remote-access/public-host settings
are refused because its browser session uses production credentials.
