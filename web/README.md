# Web Viewer

React viewer for TinyMediaViewer.

## Notes
- API contracts come from `src/generated/tmv-contract.ts`.
- Root accounts are normalized into a local store; category media is fetched and paged through React Query, with cache keys partitioned by account path, media kind, sort direction and root version.
- The account list supports persisted favorites, and `按收藏` filters the list down to favorite accounts only.
- Effects rendering goes through a shared `EffectsStage`. The requested renderer defaults to `webgpu`; if initialization fails the UI falls back to `canvas2d` and shows `WG×`.
- Video thumbnails come from `/thumb/*`. On macOS they are generated lazily by the Rust backend and cached after first request.
- App and hook tests that touch category queries need a `QueryClientProvider`; use `src/test/queryClient.tsx` instead of hand-rolling wrappers in each test.
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
