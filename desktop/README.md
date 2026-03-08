# Desktop Shell

Tauri tray application for TinyMediaViewer.

## Responsibilities
- Launch the bundled Rust sidecar `tmv-backend-app`
- Persist local settings and diagnostics
- Open the local viewer URL and expose runtime state to the settings UI
- Bundle the same Rust backend that now persists viewer preferences, favorites, thumbnail state and other local metadata into SQLite

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

Viewer UI state is also restored through the bundled backend. Search text, sort/filter mode, current account, theme, effects mode and renderer are saved through `/api/viewer-preferences` into the SQLite index, so refreshes and app relaunches keep the same viewer state without relying on browser `localStorage`.
The bundled viewer also includes the current root/category API split, append-only category paging, the system usage refresh path, and the scroll-locked media preview modal used by the web build.

## Notes
- `npm run build:dmg` is the normal packaging entry. It runs `prepare:bundle` first and then calls `tauri build --target aarch64-apple-darwin`.
- The viewer build fingerprint comes from `git rev-parse --short HEAD` plus the current UTC time. If you build from a dirty worktree, the UI still shows the last commit hash.
