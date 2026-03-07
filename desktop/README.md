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

`prepare:bundle` builds the Rust backend from `../backend-rs` and copies the release binary into `src-tauri/binaries/`.
