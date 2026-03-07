# Web Viewer

React viewer for TinyMediaViewer.

## Notes
- API contracts come from `src/generated/tmv-contract.ts`.
- Root accounts are normalized into a local store; category media stays paged and cached inside hooks.
- The account list supports persisted favorites, and `按收藏` filters the list down to favorite accounts only.
- Effects rendering goes through a shared `EffectsStage`. The requested renderer defaults to `webgpu`; if initialization fails the UI falls back to `canvas2d` and shows `WG×`.
- Video thumbnails come from `/thumb/*`. On macOS they are generated lazily by the Rust backend and cached after first request.
- Do not edit generated contracts by hand. Regenerate them from `backend-rs` with:
```bash
cd ../backend-rs
cargo run -p tmv-contract-export
```

## Commands
```bash
npm install
npm run dev
npm run lint
npm test
npm run build
```
