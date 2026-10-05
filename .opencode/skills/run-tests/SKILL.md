---
name: run-tests
description: Run the tests, run one spec, run e2e locally, investigate a skipped spec. Use for executing @openwork/testkit agent-first verification.
---

# Skill: Run Tests

## Run the landable tree

- Check out the exact PR head that will land. After any rebase or cherry-pick,
  discard the old verdict and run again.
- Run one test at a time so each failure and ambient test evidence has one owner.

## Choose the execution environment

```bash
pnpm evals:e2e <slug>
pnpm evals:pr specs/<name>.test.ts
```

The CLI prints the placement and reason; copy that line into the report. Use
e2e runs locally in this fork; there is no cloud sandbox lane and no `--daytona`
flag. Never switch lanes to turn a red run green.

## Run the core journey

The test every PR runs. Its world is a Freestyle VM, so this needs only the
evals install and the Freestyle key:

```bash
FREESTYLE_API_KEY="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent)" \
  node evals/bin/evals.mjs specs/core-chat.e2e.test.ts --local --engine v1 --surface web
```

It runs against the pushed `HEAD` commit; push first. After changing the world


## Prepare local fallback

```bash
pnpm --filter @openwork/types build
pnpm --filter @openwork/email build
```

- If the checkout path contains spaces, set `OPENWORK_EVAL_SURFACES_DIR` to a
  space-free path before E2E tests. node-gyp and electron-rebuild require it.

## Choose one lane

- Run one app-less PR-lane test:

```bash
pnpm evals:pr specs/<name>.test.ts
```

- Run one app-driving E2E test:

```bash
pnpm evals:e2e <name>
```

- The CLI owns placement and prints `placement: <local> (<reason>)`. There is no cloud sandbox placement in this fork.

## Match the runtime

Check what runtime the changed code ships on before trusting a green run.
`apps/server` runs on Bun in evals; Desktop runs that same code on Electron's
Node (undici). If the change touches fetch, streams, signals, GC, or timers,
run it on the shipping runtime too:

```bash
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc <script>
```

A green run on the wrong runtime is not evidence.

## Read the verdict

- Record the exact command, exit code, and passed/failed/skipped counts.
- Report each skip as `skipped — needs: X`; never call it passed. A green command
  containing skips makes the overall verdict `Incomplete`.
- Use `Passed`, `Incomplete`, or `Failed` for the overall result.

## Iterate, then cold-boot

- While iterating, reuse a warm Den with `OPENWORK_EVAL_DEN_API_URL`.
- Before declaring `Passed`, remove the reuse override and cold-boot through
  `server()` on the same commit.
- Inject secrets with `infisical run --silent --`; never print or echo values.
