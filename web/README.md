# Web Viewer

React viewer for TinyMediaViewer.

## Notes
- API contracts come from `src/generated/tmv-contract.ts`.
- Root accounts are fetched from `/api/root` into a normalized local store; category media is fetched from `/api/category` and paged through React Query, with cache keys partitioned by account path, media kind, sort direction and root version.
- App-level orchestration is centralized in `src/features/session/useViewerSession.ts`; it coordinates root loading, category switching, refresh, favorites, persisted viewer preferences and the system usage modal.
- `EffectsStage`, `MediaPreviewModal` and `SystemUsageModal` are loaded with `React.lazy` only when the corresponding UI path is used; if persisted preferences already say effects are off, the effects chunk is not pulled on first load.
- Category paging keeps an append-only aggregate of loaded pages for the current query key, so loading more media does not rebuild the entire client-side media array each time; switching to a different key rebuilds from the React Query pages for that key instead of using a separate module-level LRU cache.
- The root account store keeps `subfoldersByPath + orderBy*` arrays, but preview backfill and favorite toggles patch only the affected paths into the sorted arrays instead of re-sorting the full account list.
- The account list supports persisted favorites, and `按收藏` filters the list down to favorite accounts only.
- The account list toolbar supports `按时间` / `按名称` / `按收藏` / `按随机`. Random mode uses a deterministic seed so the order stays stable until the random button is clicked again.
- Account rows use a full-pill hit target for selection, while the favorite button remains an independent click target.
- The media toolbar supports `按时间+` / `按时间-` / `按随机`. Media randomization is applied client-side over the currently loaded items so rerolling does not refetch backend pages.
- Viewer preferences are not stored in `localStorage` anymore. Search text, account sort/filter/random seed, current account, media filter/sort/random seed, theme, manual theme, effects mode and renderer are loaded and saved through `/api/viewer-preferences`, then persisted by the Rust backend into SQLite.
- The toolbar includes a `系统占用情况` modal backed by `/api/system-usage`. It shows the top accounts by total usage plus the selected account's top 5 largest files, uses a 30 second query `staleTime`, and supports explicit refresh via `refresh=1`.
- Effects rendering goes through a shared `EffectsStage`. The requested renderer defaults to `webgpu`; if initialization fails the UI falls back to `canvas2d` and shows `WG×`. The WebGPU path now renders particles and heart pulses with instanced GPU draws instead of copying a CPU-rasterized frame into a texture every tick.
- Video thumbnails come from `/thumb/*`. On macOS they are generated lazily by the Rust backend and cached after first request.
- Root preview backfill runs in batched requests and degrades concurrency from 2 to 1 when preview batches time out or partially fail, then recovers after a success streak.
- Opening the media preview modal locks background scrolling so touch gestures on tablets and phones do not scroll the underlying page.
- Preview selection reconciliation and modal prev/next navigation use a `path -> index` map for the current media list, so refreshes and large categories no longer trigger repeated linear scans across the full array.
- Query-backed viewer preferences are centralized in `src/features/ui/useViewerPreferences.ts`; tests that exercise persisted UI state should mock the backend API, not `localStorage`.
- App and hook tests that touch category queries need a `QueryClientProvider`; use `src/test/queryClient.tsx` instead of hand-rolling wrappers in each test.
- `useCategoryMedia` no longer exposes a manual `invalidateCategoryCache`; refresh behavior is driven by `rootVersion` in the query key plus category restore/reselect logic.
- Do not edit generated contracts by hand. Regenerate them from `backend-rs` with:
```bash
cd ../backend-rs
cargo run -p tmv-contract-export
```

## Commands
```bash
npm install
npm run dev
npm run preview
npm run lint
npm test
npm run build
```
