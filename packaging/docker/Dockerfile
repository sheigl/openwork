# syntax=docker/dockerfile:1

# Self-hosted OpenWork server, built from this repository.
#
# The upstream image installed `openwork-server` from the public npm registry.
# This fork is not published there, so the build stage compiles the server and
# the self-host web UI from source and ships the staged package as-is.
#
# Build from the repository root:
#   docker build -f packaging/docker/Dockerfile -t openwork .

# ---------- Build: the monorepo (server + web UI) ----------
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# pnpm pinned by the packageManager field; bun is the bundler the server and
# app builds use.
RUN npm install -g pnpm@10.27.0 bun

WORKDIR /src
COPY . .

# Only the server, the web app, and their workspace dependencies. The desktop
# app (Electron) is not part of a containerized deployment.
RUN pnpm install --filter "openwork-server..." --filter "@openwork/app..."

# Stages the publishable package layout at apps/server/dist/npm:
# bin/ launcher, dist/openwork-server.mjs bundle, dist/opencode-plugins/,
# dist/pdfium.wasm, and web/ (the self-host web UI).
RUN pnpm --filter openwork-server prepare:npm

# ---------- Runtime ----------
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.30
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# The staged package built from this fork, in the npm global layout: the
# package dir, its runtime deps, and the /usr/local/bin launcher symlink.
# Installed by direct copy (npm pack/install of the 51MB package is
# needlessly slow on slow build disks).
COPY --from=build /src/apps/server/dist/npm/ /usr/local/lib/node_modules/openwork-server/
RUN cd /usr/local/lib/node_modules/openwork-server \
  && npm install --omit=dev --no-audit --no-fund \
  && ln -s ../lib/node_modules/openwork-server/bin/openwork-server.mjs /usr/local/bin/openwork-server

# The OpenCode engine binary. The server manages this process
# (OPENWORK_MANAGE_OPENCODE) and nothing else in the image phones home.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="opencode-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$OPENCODE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/opencode; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/openwork-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV OPENWORK_DATA_DIR=/data/openwork-orchestrator
ENV OPENWORK_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV OPENWORK_WORKSPACE=/workspace

# The engine binary installed above; the server uses it directly instead of
# downloading one into the data dir on first run.
ENV OPENWORK_OPENCODE_BIN=/usr/local/bin/opencode

# OpenWork host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# `web` serves the bundled web UI, pins stable tokens in the data dir, and
# manages the OpenCode engine (approval defaults to auto, since the web UI
# has no approvals responder; set OPENWORK_APPROVAL_MODE=manual to override).
CMD ["/bin/sh", "-lc", "exec openwork-server web --workspace \"${OPENWORK_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${OPENWORK_PORT:-8787}\" --cors \"${OPENWORK_CORS_ORIGINS:-*}\""]
