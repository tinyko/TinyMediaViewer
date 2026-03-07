# Desktop Shell

Tauri tray application for TinyMediaViewer.

## Responsibilities
- Launch the bundled Rust sidecar `tmv-backend-app`
- Persist local settings and diagnostics
- Open the local viewer URL and expose runtime state to the settings UI

## Packaging
```bash
npm install
npm run prepare:bundle
npm run build:dmg
```

`prepare:bundle` does four things:
- Builds `tmv-backend-app` for `aarch64-apple-darwin`
- Copies the Rust sidecar into `src-tauri/binaries/`
- Builds the `../web` viewer and copies static assets into `src-tauri/resources/viewer/`
- Injects `VITE_TMV_APP_VERSION`, `VITE_TMV_SHORT_COMMIT` and `VITE_TMV_BUILD_TIME` so the viewer can show a build fingerprint

The desktop bundle does not require a separately installed `ffmpeg`. Image and GIF thumbnails are generated inside the Rust backend, and macOS video thumbnails use AVFoundation.

## Notes
- `npm run build:dmg` is the normal packaging entry. It runs `prepare:bundle` first and then calls `tauri build --target aarch64-apple-darwin`.
- The viewer build fingerprint comes from `git rev-parse --short HEAD` plus the current UTC time. If you build from a dirty worktree, the UI still shows the last commit hash.
