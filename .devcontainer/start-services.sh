#!/usr/bin/env bash
set -euo pipefail

# Start all services for the devcontainer workspace.
# Launches the real Electron app with a virtual display.
#
# Usage: bash .devcontainer/start-services.sh
#
# Services started:
#   - Xvfb + noVNC (port 6080) — see the Electron app in your browser
#   - Vite dev server (port 5173) — React UI with HMR
#   - Electron app — the real desktop app on the virtual display
#   - CDP debugging (port 9825) — for automation

cd /workspace

# ── 1. Virtual display + noVNC ──
# Previously delegated to start-daytona-vnc.sh, which went away with the
# Daytona sandbox tooling. The Xvfb/noVNC stack it started is all that is
# needed here.
echo "==> Starting virtual display..."
export DISPLAY=":99"
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 15); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "Xvfb ready on :99."
    break
  fi
  sleep 1
done
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
sleep 2

# ── 2. Vite dev server on 0.0.0.0 (so Electron can reach it via 127.0.0.1) ──
echo "==> Starting Vite on :5173..."
cd apps/app
OPENWORK_DEV_MODE=1 nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 &
cd /workspace
sleep 3

# ── 3. Electron app ──
echo "==> Starting Electron app..."
pnpm --filter @openwork/desktop dev:electron > /tmp/electron.log 2>&1 &
disown || true

# ── 4. Wait for Electron to be ready ──
echo "==> Waiting for Electron..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:9825/json/list >/dev/null 2>&1; then
    echo "Electron CDP ready."
    break
  fi
  sleep 2
done


echo ""
echo "============================================"
echo "  All services running!"
echo ""
echo "  Desktop App (noVNC):  http://localhost:6080"
echo "  CDP Debug:            ws://127.0.0.1:9825"
echo "  Vite HMR:             http://localhost:5173"
echo "============================================"
echo ""

# Keep alive
wait
