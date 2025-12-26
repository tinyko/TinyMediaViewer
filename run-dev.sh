#!/usr/bin/env bash
set -euo pipefail

# Starts Fastify backend and Vite frontend together.

ROOT="$(cd "$(dirname "$0")" && pwd)"
MEDIA_ROOT="${MEDIA_ROOT:-$(cd "$ROOT/.." && pwd)}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [[ -n "${WEB_PID:-}" ]]; then kill "$WEB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "Media root: $MEDIA_ROOT"
echo "Starting backend..."
(cd "$ROOT/server" && MEDIA_ROOT="$MEDIA_ROOT" SERVER_HOST=0.0.0.0 npm run dev -- --host 0.0.0.0) &
SERVER_PID=$!

sleep 1
echo "Starting frontend..."
(cd "$ROOT/web" && npm run dev -- --host) &
WEB_PID=$!

echo "Backend PID: $SERVER_PID | Frontend PID: $WEB_PID"
echo "Press Ctrl+C to stop both."

wait
