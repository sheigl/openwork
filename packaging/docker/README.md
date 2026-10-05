# Docker packaging

Container images and Compose stacks for self-hosting `openwork-server`.

<Note>
This fork has no hosted control plane. The Den Dockerfiles
(`Dockerfile.den`, `Dockerfile.den-web`, `Dockerfile.den-gateway`,
`Dockerfile.gateway`), the `openwork-ee` Helm chart, the AWS ECS Terraform
module, and the pull-only evaluation stack were all part of that control plane
and have been removed. What remains is the single `openwork-server` image.
</Note>

## Files here

| File | What it is |
| --- | --- |
| `Dockerfile` | The production image. Installs `openwork-server` from npm and a pinned OpenCode binary. |
| `docker-compose.yml` | Single `openwork-host` service built from that Dockerfile. |
| `docker-compose.dev.yml` | Dev testability stack — no custom Dockerfile, prints a ready-to-use Web UI URL. |
| `Dockerfile.microsandbox` | Builds the local sandbox image used for isolated task execution. |
| `microsandbox-entrypoint.sh` | Entrypoint for the microsandbox image. |
| `docker-compose.otel-lgtm.yml` | A self-contained Grafana/LGTM observability stack for OpenTelemetry traces. |
| `otel-lgtm-validate.sh` | Starts the observability stack and validates that traces arrive. |

## The production image

`Dockerfile` builds on `node:22-bookworm-slim` and installs:

1. `openwork-server` at a pinned version from npm.
2. A pinned OpenCode release binary from GitHub, so packaged builds do not need
   OpenCode installed at runtime.

It also creates the persistent data path. **Mount a volume there** — that
directory is your deployment's state, and there is no separate database to back
up.

```bash
docker build -f packaging/docker/Dockerfile \
  --build-arg OPENWORK_SERVER_VERSION=0.18.4 \
  --build-arg OPENCODE_VERSION=1.17.11 \
  -t openwork-server:local .

docker run --rm -p 8787:8787 -v openwork-data:/data openwork-server:local
```

Override `OPENCODE_DOWNLOAD_URL` to pin the OpenCode build from an internal
mirror instead of GitHub. If you build on `linux/amd64` and run on `arm64`
(or the reverse), the `install` step picks the asset matching the target
architecture at build time, so build for the platform you deploy on.

## Running it

```bash
docker compose -f packaging/docker/docker-compose.yml up -d
```

The server writes its configuration to `~/.config/openwork` by default; mount
that path if you want the host to own it rather than a volume inside the
container.

> **Do not publish the port.** `openwork-server` authorizes whatever can reach
> it — it injects a valid client token into the page it serves for *any* `Host`
> header. Keep it on loopback or put an authenticating reverse proxy in front of
> it. See [Self-host](/start-here/self-host).

## Development

```bash
docker compose -f packaging/docker/docker-compose.dev.yml up
```

This one is already wired for headless use — it generates a token if you have
not set one and prints the Web UI URL. Optional overrides:

| Variable | Effect |
| --- | --- |
| `OPENWORK_TOKEN` | Shared client token (auto-generated if unset) |
| `OPENWORK_HOST_TOKEN` | Host/admin token (auto-generated if unset) |
| `OPENWORK_WORKSPACE` | Host path to mount as the workspace (default `./workspace`) |
| `OPENWORK_PORT` | Host port mapped to the container's `8787` |

## Observability

```bash
docker compose -f packaging/docker/docker-compose.otel-lgtm.yml up -d
./packaging/docker/otel-lgtm-validate.sh
```

This stack is self-contained and does not send anything to a hosted backend.
Point your deployment's OTLP exporter at it if you want traces in Grafana.

## Isolated sandboxes

`Dockerfile.microsandbox` builds the image used when a task runs in an isolated
sandbox rather than directly on your machine. It is a local image — build it
locally and reference it from your own configuration. There is no hosted
sandbox provider in this fork.

## What was removed

For the record, so nobody goes looking for it:

- `Dockerfile.den`, `Dockerfile.den-web`, `Dockerfile.den-gateway`,
  `Dockerfile.gateway` — the Den API, Den web, and OpenWork Gateway images.
- `docker-compose.den-dev.yml`, `docker-compose.eval.yml` — the pull-only
  Den development and evaluation stacks.
- `den-dev-up.sh`, `otel-hono-live-validate.{sh,mjs}` — helpers for the stacks
  above.
- `../helm/openwork-ee/` — the Kubernetes chart for the control plane.
- `../../infra/terraform/modules/openwork-aws-ecs/` — the AWS ECS module.