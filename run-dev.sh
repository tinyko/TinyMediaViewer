#!/usr/bin/env bash
set -euo pipefail

# Starts the Rust backend and Vite frontend together.

ROOT="$(cd "$(dirname "$0")" && pwd)"
MEDIA_ROOT="${MEDIA_ROOT:-$(cd "$ROOT/.." && pwd)}"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "Media root: $MEDIA_ROOT"
echo "Starting backend..."
(cd "$ROOT/backend-rs" && \
  TMV_RUNTIME_MODE=legacy \
  TMV_MEDIA_ROOT="$MEDIA_ROOT" \
  TMV_BIND_HOST=0.0.0.0 \
  TMV_PORT=4000 \
  TMV_VIEWER_DIR="$ROOT/desktop/src-tauri/resources/viewer" \
  cargo run -p tmv-backend-app) &
BACKEND_PID=$!

sleep 1
echo "Starting frontend..."
(cd "$ROOT/web" && npm run dev -- --host) &
WEB_PID=$!

echo "Backend PID: $BACKEND_PID | Frontend PID: $WEB_PID"
echo "Press Ctrl+C to stop both."

wait
