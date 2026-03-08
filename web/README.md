# Web Viewer

React viewer for TinyMediaViewer.

## Notes
- API contracts come from `src/generated/tmv-contract.ts`.
- Root accounts are normalized into a local store; category media is fetched and paged through React Query, with cache keys partitioned by account path, media kind, sort direction and root version.
- The account list supports persisted favorites, and `按收藏` filters the list down to favorite accounts only.
- The account list toolbar supports `按时间` / `按名称` / `按收藏` / `按随机`. Random mode uses a deterministic seed so the order stays stable until the random button is clicked again.
- The media toolbar supports `按时间+` / `按时间-` / `按随机`. Media randomization is applied client-side over the currently loaded items so rerolling does not refetch backend pages.
- Viewer preferences are not stored in `localStorage` anymore. Search text, account sort/filter/random seed, current account, media filter/sort/random seed, theme, manual theme, effects mode and renderer are loaded and saved through `/api/viewer-preferences`, then persisted by the Rust backend into SQLite.
- The toolbar includes a `系统占用情况` modal backed by `/api/system-usage`. It shows the top accounts by total usage plus the selected account's top 5 largest files.
- Effects rendering goes through a shared `EffectsStage`. The requested renderer defaults to `webgpu`; if initialization fails the UI falls back to `canvas2d` and shows `WG×`.
- Video thumbnails come from `/thumb/*`. On macOS they are generated lazily by the Rust backend and cached after first request.
- Query-backed viewer preferences are centralized in `src/features/ui/useViewerPreferences.ts`; tests that exercise persisted UI state should mock the backend API, not `localStorage`.
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
