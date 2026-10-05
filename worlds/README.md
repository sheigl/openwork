# Worlds

A world is a checked-in script that brings up a running OpenWork environment.
This fork has **three**, and all of them run on this computer.

```bash
pnpm world list
pnpm world plan <name>
pnpm world up <name> --detach
pnpm world down <name>
```

## The worlds

| World | What it is |
| --- | --- |
| `dev-app-web` | Your working tree as the local `openwork-server` plus the browser UI. Keeps its state between runs. This is the one you want. |
| `live-app-web` | The source web app against your **installed production** desktop state. Needs `-- --allow-shared-state`. |
| `live-desktop` | The source desktop app against your installed production state. Needs `-- --allow-shared-state`. |

`pnpm dev` and `pnpm dev:headless-web` are aliases for the headless-web flow.

## Placements

`--place local` is the **only** placement. It means this computer.

```bash
pnpm world plan dev-app-web --place local
```

There are no remote placements. The cloud sandbox providers this fork used to
support — Daytona and Freestyle — went with the hosted control plane, along
with the `preview-*` worlds that depended on them. Asking for one fails with an
unknown-placement error rather than silently falling back to local.

## dev-app-web

The default path for working on OpenWork itself. It is an isolated launcher: it
writes `tmp/headless-server.json` and never reads `~/.config/openwork/server.json`,
so it cannot disturb a real deployment.

```bash
pnpm world up dev-app-web --detach
```

- Authorizes the chosen workspace root automatically, and merges (never
  rewrites) that config on relaunch, so workspaces you add through the UI
  survive `--replace`.
- Starts Vite plus `openwork-server` with a stable owner bearer forced into the
  UI. Crash-restarts keep open tabs working. The privileged host token stays on
  the server process and is never inlined into the Vite bundle.
- Publishes an owner-only runtime manifest at `tmp/dev-headless-web.json`
  (`0600`), and allows browser calls only from the web app's own origins — not
  every site you visit.
- Stable ports by default (web `5178`, server `8778`; falls back to free ports
  when taken, override with `OPENWORK_WEB_PORT` / `OPENWORK_PORT`).
- Single-instance as `dev-app-web`; stop it with `pnpm world down dev-app-web`
  before launching it again.
- Keeps Vite and the backend under one script lifecycle, so either sibling
  exiting stops the other instead of leaving an orphan.
- In detached mode, waits for health, prints non-secret outputs and
  receipt/log paths, and exits.

There is **no sign-in step** in this fork. The control plane that hosted it is
gone, so the launcher authorizes the workspace root directly.

Script-specific options must follow `--`:

```bash
pnpm world up dev-app-web --detach -- --replace
pnpm world up dev-app-web --detach -- --replace --keep-tokens
```

`--replace` restarts the headless runtime with fresh tokens; `--keep-tokens`
retains the previous ones. `--rotate-tokens` is also accepted. These are not
generic `world` options.

## live-app-web and live-desktop

Both intentionally **share your installed production state** — the same profile
your released desktop app uses. That is the point: you run source against real
state. It also means they can mutate it, so both require an explicit opt-in
after `--`:

```bash
pnpm world up live-desktop -- --allow-shared-state
```

Read what a world does before pointing it at real state.

## What was removed

- `preview-desktop`, `preview-app-web` — cloud sandbox previews
- `preview-den`, `preview-full` — the Den control plane and Den+desktop worlds
- `--place daytona` and `--place freestyle`
- `--source <sha|ref>` pinning, which only made sense for a pushed commit built
  remotely. Local worlds run the working tree, uncommitted changes included.
- The Acme demo and docs-screenshot worlds

## Writing a world

A world is a TypeScript module in this directory exporting `summary`,
`supportedTargets`, and `main`. `supportedTargets` must be a subset of what
`packages/world` accepts — in practice `local/host` on any machine and
`local/macos` for the production-state worlds.

Keep it simple. A world that needs MySQL, Redis, or two extra services is
re-creating the infrastructure this fork removed.