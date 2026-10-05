# AGENTS.md

OpenWork is a free, open-source desktop app (macOS, Windows, Linux) for doing
work with AI agents on your own files — an open-source alternative to Claude
Cowork and Codex, built on OpenCode, running any model from 50+ providers.

## This is a self-hosted-only fork

**OpenWork's hosted control plane has been removed from this repository.** This
is the most important thing to know before changing anything here.

Removed:

* `ee/` — OpenWork Den, the organization control plane, its MCP gateway, and
  hosted inference.
* `packages/sdk` — the generated Den API client (it hardcoded
  `https://api.openworklabs.com`).
* The cloud deployment artifacts: `packaging/helm/openwork-ee`, the AWS ECS
  Terraform module, the Den Dockerfiles and compose stacks.
* Daytona cloud sandboxes and the CI that drove them.
* The `required-for-cloud` egress requirement level.

Do not reintroduce any of these. Do not add a default that points at
`openworklabs.com` or any other host we do not control.

What replaced the defaults:

| Surface | Behavior |
| --- | --- |
| Model catalog | `OPENCODE_MODELS_URL` is optional. Unset means the `OPENCODE_MODELS_URL` key is omitted entirely — there is no fallback to a remote mirror. |
| Free inference | **Opt-in.** `OPENWORK_ENABLE_FREE_INFERENCE=1` plus an explicitly configured origin. Unconfigured, `free-auto/settings.ts` resolves to an inert sentinel and never connects. |
| Control plane | `apps/app` and the desktop shell resolve their base URL from build/env config and fall back to "no control plane configured". There is no `app.openworklabs.com` default. |
| Cloud trust lists | `BUILTIN_APP_HOST_CLOUD_ORIGINS`, `BUILT_IN_CLOUD_MCP_ORIGINS`, and the cloud-probe `DEFAULT_TRUSTED_ORIGINS` are empty. |
| Analytics | The PostHog project key is not baked in. `resolvePosthogKey` returns `""` and every send path in `analytics.ts` returns early on an empty key. |
| Feedback / docs links | No defaults. `buildFeedbackUrl` returns `null` and callers hide the surface; the Docs menu item only appears when `OPENWORK_DOCS_PAGE_URL` / `VITE_OPENWORK_DOCS_PAGE_URL` is set. |

## Verify egress before you claim it

The repository carries a machine-readable allowlist and an auditor:

```bash
node scripts/check-outbound-access.mjs
```

It scans `apps/server/src`, `apps/app/src`, `apps/desktop/electron`, and
`packages/openwork-bootstrap/bin` for external hosts and fails on drift against
`docs/enterprise/outbound-access.json`. If you add an outbound request, add the
host to that manifest with its purpose, blocked effect, and override — and if
you *remove* one, remove its entry.

## Surfaces

* **Desktop app** (`apps/app`, `apps/desktop`, `packages/`) — local-first agent
  workspace: chat on files, skills, browser automation, scheduled automations,
  Anthropic-compatible plugins.
* **`openwork-server`** (`apps/server`) — the headless backend. Serves the web
  UI and the local agent runtime. This is what self-hosters run.

Anything OpenCode can do is available in OpenWork, even before a dedicated UI
exists.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Coding

* pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* Any user-facing UI follows `DESIGN.md`: read it before designing, cite its
  rule ids in PRs, and attach screenshots of new UI. The optional
  `.warden/skills/design-spec-review` skill can review these rules locally.

## Scripts that no longer exist

Removed along with the cloud. Do not reference them:

`sdk:generate`, `sdk:build`, `sdk:check`, `api:lint`, `api:snapshot`,
`den:*`, `build:web`, `dev:den:*`, `dev:enterprise-mock-lab`, `dev:diagnostics`,
`check:enterprise-mock-lab`, `check:diagnostics`, `dev:web`,
`benchmark:admin-scale:mysql`.
