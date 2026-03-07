#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend-rs"
WEB_DIR="$REPO_ROOT/web"
TAURI_DIR="$ROOT/src-tauri"
APP_VERSION="$(node -e "console.log(require('$TAURI_DIR/tauri.conf.json').version)")"
SHORT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

BACKEND_OUT="$TAURI_DIR/binaries/tmv-backend-app-aarch64-apple-darwin"
VIEWER_OUT="$TAURI_DIR/resources/viewer"

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "backend-rs directory not found: $BACKEND_DIR" >&2
  exit 1
fi

if [[ ! -d "$WEB_DIR" ]]; then
  echo "web directory not found: $WEB_DIR" >&2
  exit 1
fi

echo "[1/4] Building Rust backend binary (macOS arm64)..."
(cd "$BACKEND_DIR" && cargo build --release --target aarch64-apple-darwin -p tmv-backend-app)

echo "[2/4] Copying Rust backend binary..."
cp "$BACKEND_DIR/target/aarch64-apple-darwin/release/tmv-backend-app" "$BACKEND_OUT"
chmod +x "$BACKEND_OUT"
rm -f "$TAURI_DIR/binaries/media-viewer-server-aarch64-apple-darwin"

echo "[3/4] Preparing Rust-only bundle resources..."

echo "[4/4] Building and copying Viewer static assets..."
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

echo "Prepared backend: $BACKEND_OUT"
echo "Prepared viewer assets: $VIEWER_OUT"
echo "Viewer version fingerprint: v$APP_VERSION+$SHORT_COMMIT ($BUILD_TIME)"
