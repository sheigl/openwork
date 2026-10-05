# Dev Container Setup

Runs the real OpenWork Electron desktop app inside a container with a virtual
display you can reach from your browser over noVNC.

Everything here used to be oriented around OpenWork's hosted cloud (the `ee/`
Den control plane and Daytona cloud sandboxes). Both have been removed from
this fork, so what remains is a plain local devcontainer.

## What's here

| File | Purpose |
| --- | --- |
| `Dockerfile` | Node 20 + Electron system deps + Xvfb/noVNC/bun |
| `docker-compose.yml` | Single `workspace` service, port-forwarded |
| `devcontainer.json` | Codespaces / devcontainers entry point |
| `start-services.sh` | Boots Xvfb, noVNC, Vite and Electron |
| `dev-sandbox.sh` | One-shot sandbox bootstrap |

## Quick start

```bash
docker compose -f .devcontainer/docker-compose.yml up -d
docker compose -f .devcontainer/docker-compose.yml exec workspace \
  bash .devcontainer/start-services.sh
```

Then open:

- **Desktop app (noVNC):** http://localhost:6080
- **Vite HMR:** http://localhost:5173
- **Electron CDP:** `ws://127.0.0.1:9825`

## Ports

| Port | Service |
| --- | --- |
| 5173 | App Vite dev server (HMR) |
| 6080 | noVNC — the Electron desktop app in your browser |
| 9825 | Electron CDP remote debugging |

## Removed with the cloud control plane

- MySQL 8.4 and every `DEN_*` / `BETTER_AUTH_*` / `DATABASE_URL` variable.
  Den is the hosted control plane and is gone from this fork.
- All `*daytona*` scripts and `Dockerfile.daytona-*`. Daytona cloud sandboxes
  are gone along with `ee/packages/cloud-runtime-daytona`.
- Port 3005 (Den Web) and 8788 (Den API).

The Xvfb/noVNC startup that `start-daytona-vnc.sh` used to own is now inline in
`start-services.sh`, and Electron starts via `pnpm --filter @openwork/desktop
dev:electron`.