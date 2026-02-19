#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"
WEB_DIR="$REPO_ROOT/web"
TAURI_DIR="$ROOT/src-tauri"
APP_VERSION="$(node -e "console.log(require('$TAURI_DIR/tauri.conf.json').version)")"
SHORT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

SIDECAR_OUT="$TAURI_DIR/binaries/media-viewer-server-aarch64-apple-darwin"
VIEWER_OUT="$TAURI_DIR/resources/viewer"

if [[ ! -d "$SERVER_DIR" ]]; then
  echo "server directory not found: $SERVER_DIR" >&2
  exit 1
fi

if [[ ! -d "$WEB_DIR" ]]; then
  echo "web directory not found: $WEB_DIR" >&2
  exit 1
fi

echo "[1/3] Building Fastify server TypeScript output..."
(cd "$SERVER_DIR" && npm run build)

echo "[2/3] Packaging server sidecar binary (macOS arm64)..."
(cd "$SERVER_DIR" && npx --yes @yao-pkg/pkg dist/server.js --target node20-macos-arm64 --output "$SIDECAR_OUT")
chmod +x "$SIDECAR_OUT"

echo "[3/3] Building and copying Viewer static assets..."
(
  cd "$WEB_DIR" && \
    VITE_TMV_APP_VERSION="$APP_VERSION" \
    VITE_TMV_SHORT_COMMIT="$SHORT_COMMIT" \
    VITE_TMV_BUILD_TIME="$BUILD_TIME" \
    npm run build
)
rm -rf "$VIEWER_OUT"
mkdir -p "$VIEWER_OUT"
cp -R "$WEB_DIR/dist/." "$VIEWER_OUT/"

echo "Prepared sidecar: $SIDECAR_OUT"
echo "Prepared viewer assets: $VIEWER_OUT"
echo "Viewer version fingerprint: v$APP_VERSION+$SHORT_COMMIT ($BUILD_TIME)"
