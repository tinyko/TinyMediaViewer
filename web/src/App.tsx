import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "./features/effects/effects.css";
import { fetchFolder, fetchFolderPreviews } from "./api";
import type { FolderPayload, MediaItem } from "./types";
import { MediaPreviewModal } from "./features/preview/MediaPreviewModal";
import { formatBytes, formatDate } from "./utils";
import { ParticleField } from "./features/effects/ParticleField";
import { HeartPulseLayer } from "./features/effects/HeartPulseLayer";
import {
  filterMediaByKind,
  mergeMediaByPath,
  sortMediaByTime,
} from "./features/category/mediaUtils";

type Theme = "light" | "dark";

const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;
const SERVER_PAGE_SIZE = 240;
const INITIAL_VISIBLE_ITEMS = 48;
const PAGE_STEP = 32;
const ROOT_PREVIEW_BATCH_SIZE = 20;
const ROOT_PREVIEW_MAX_CONCURRENCY = 4;
const ROOT_PREVIEW_RETRY_LIMIT = 1;

const makeHeartCursor = (hue: number) => {
  const color = `hsl(${hue},85%,70%)`;
  const stroke = `hsl(${hue},90%,92%)`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><path d='M16 29s-9-5.7-12-12c-3-6.3 4-13 12-5.5C24-1 31 5.7 28 12 25 18.3 16 29 16 29z' fill='${color}' stroke='${stroke}' stroke-width='1.6' stroke-linejoin='round'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`;
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

type CategoryCacheEntry = {
  payload: FolderPayload;
  nextCursor?: string;
};

function App() {
  const getInitialTheme = (): Theme => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem("mv-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const getInitialLowPerf = () => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("mv-low-performance");
    if (stored === "true") return true;
    if (stored === "false") return false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lowCpu = (window.navigator.hardwareConcurrency ?? 8) <= 4;
    return reducedMotion || lowCpu;
  };

  const [folder, setFolder] = useState<FolderPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const [categoryPreview, setCategoryPreview] = useState<FolderPayload | null>(null);
  const [categoryVisibleCount, setCategoryVisibleCount] = useState(INITIAL_VISIBLE_ITEMS);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryLoadingMore, setCategoryLoadingMore] = useState(false);
  const [categoryHasMore, setCategoryHasMore] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [sortMode, setSortMode] = useState<"time" | "name">("time");
  const [mediaSort, setMediaSort] = useState<"asc" | "desc">("desc");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [heartCursorVisible, setHeartCursorVisible] = useState(false);
  const heartCursorRef = useRef<HTMLDivElement | null>(null);
  const heartCursorPos = useRef({ x: 0, y: 0 });
  const heartCursorRaf = useRef<number | null>(null);
  const [heartHue, setHeartHue] = useState(0);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [manualTheme, setManualTheme] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("mv-theme-manual") === "true";
  });
  const [lowPerformanceMode, setLowPerformanceMode] = useState(getInitialLowPerf);
  const effectsEnabled = !lowPerformanceMode;
  const previewCache = useRef(new Map<string, CategoryCacheEntry>());
  const rootAbortRef = useRef<AbortController | null>(null);
  const categoryAbortRef = useRef<AbortController | null>(null);
  const rootRequestSeq = useRef(0);
  const categoryRequestSeq = useRef(0);
  const categoryLoadMoreSeq = useRef(0);
  const categoryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const categoryListRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const hoveredCardRef = useRef<HTMLButtonElement | null>(null);
  const rootPreviewSeq = useRef(0);
  const rootPreviewPending = useRef<string[]>([]);
  const rootPreviewPendingSet = useRef(new Set<string>());
  const rootPreviewInFlight = useRef(new Set<string>());
  const rootPreviewRetry = useRef(new Map<string, number>());
  const rootPreviewRunning = useRef(0);
  const rootPreviewControllers = useRef(new Set<AbortController>());
  const versionLabel = "v0.6.0";

  const resetRootPreviewQueue = useCallback(() => {
    rootPreviewSeq.current += 1;
    rootPreviewPending.current = [];
    rootPreviewPendingSet.current.clear();
    rootPreviewInFlight.current.clear();
    rootPreviewRetry.current.clear();
    rootPreviewRunning.current = 0;
    for (const controller of rootPreviewControllers.current) {
      controller.abort();
    }
    rootPreviewControllers.current.clear();
  }, []);

  const applyPreviewBatch = useCallback((items: FolderPayload["subfolders"]) => {
    if (!items.length) return;
    const updateMap = new Map(items.map((item) => [item.path, item]));
    setFolder((previous) => {
      if (!previous) return previous;
      let changed = false;
      const subfolders = previous.subfolders.map((item) => {
        const patch = updateMap.get(item.path);
        if (!patch) return item;
        changed = true;
        return {
          ...item,
          modified: patch.modified,
          counts: patch.counts,
          previews: patch.previews,
          countsReady: true,
          previewReady: true,
          approximate: false,
        };
      });
      return changed ? { ...previous, subfolders } : previous;
    });
  }, []);

  const pumpRootPreviewQueue = useCallback(() => {
    const seq = rootPreviewSeq.current;
    while (
      rootPreviewRunning.current < ROOT_PREVIEW_MAX_CONCURRENCY &&
      rootPreviewPending.current.length
    ) {
      const batch: string[] = [];
      while (
        batch.length < ROOT_PREVIEW_BATCH_SIZE &&
        rootPreviewPending.current.length
      ) {
        const next = rootPreviewPending.current.shift();
        if (!next) break;
        rootPreviewPendingSet.current.delete(next);
        if (rootPreviewInFlight.current.has(next)) continue;
        batch.push(next);
        rootPreviewInFlight.current.add(next);
      }
      if (!batch.length) break;

      rootPreviewRunning.current += 1;
      const controller = new AbortController();
      rootPreviewControllers.current.add(controller);

      void fetchFolderPreviews(
        {
          paths: batch,
          limitPerFolder: 6,
        },
        {
          signal: controller.signal,
        }
      )
        .then((result) => {
          if (seq !== rootPreviewSeq.current) return;
          applyPreviewBatch(result.items);
        })
        .catch((error) => {
          if (isAbortError(error) || seq !== rootPreviewSeq.current) return;
          for (const failedPath of batch) {
            const retry = rootPreviewRetry.current.get(failedPath) ?? 0;
            if (retry >= ROOT_PREVIEW_RETRY_LIMIT) continue;
            rootPreviewRetry.current.set(failedPath, retry + 1);
            if (
              !rootPreviewPendingSet.current.has(failedPath) &&
              !rootPreviewInFlight.current.has(failedPath)
            ) {
              rootPreviewPending.current.push(failedPath);
              rootPreviewPendingSet.current.add(failedPath);
            }
          }
        })
        .finally(() => {
          rootPreviewControllers.current.delete(controller);
          for (const finishedPath of batch) {
            rootPreviewInFlight.current.delete(finishedPath);
          }
          rootPreviewRunning.current = Math.max(0, rootPreviewRunning.current - 1);
          if (seq === rootPreviewSeq.current) {
            queueMicrotask(() => pumpRootPreviewQueue());
          }
        });
    }
  }, [applyPreviewBatch]);

  const enqueueRootPreviewPaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      const readyPaths = new Set(
        folder?.subfolders.filter((item) => item.countsReady).map((item) => item.path)
      );
      for (const input of paths) {
        const candidate = input.trim();
        if (!candidate || readyPaths.has(candidate)) continue;
        if (
          rootPreviewPendingSet.current.has(candidate) ||
          rootPreviewInFlight.current.has(candidate)
        ) {
          continue;
        }
        rootPreviewPending.current.push(candidate);
        rootPreviewPendingSet.current.add(candidate);
      }
      pumpRootPreviewQueue();
    },
    [folder?.subfolders, pumpRootPreviewQueue]
  );

  const filteredAccounts = useMemo(() => {
    if (!folder) return [];
    const items = folder.subfolders.filter((item) => {
      const matchesText = item.name.toLowerCase().includes(search.toLowerCase());
      if (!matchesText) return false;
      if (!item.countsReady) return true;
      const hasKind =
        mediaFilter === "image"
          ? item.counts.images + item.counts.gifs > 0
          : item.counts.videos > 0;
      return hasKind;
    });
    return items.sort((a, b) => {
      if (sortMode === "name") {
        return a.name.localeCompare(b.name);
      }
      return b.modified - a.modified;
    });
  }, [folder, search, mediaFilter, sortMode]);

  const filteredCategoryMedia = useMemo(() => {
    const source = categoryPreview?.media ?? [];
    const filtered = filterMediaByKind(source, mediaFilter);
    return sortMediaByTime(filtered, mediaSort);
  }, [categoryPreview, mediaFilter, mediaSort]);

  const visibleCategoryMedia = filteredCategoryMedia.slice(0, categoryVisibleCount);
  const totalMedia = categoryPreview?.totals.media ?? 0;
  const visibleCount = filteredCategoryMedia.length;
  const meterPercent = totalMedia ? Math.min(100, (visibleCount / totalMedia) * 100) : 0;
  const selectedIndex = selected
    ? filteredCategoryMedia.findIndex((item) => item.path === selected.path)
    : -1;

  const loadRoot = useCallback(async () => {
    rootAbortRef.current?.abort();
    resetRootPreviewQueue();
    const controller = new AbortController();
    rootAbortRef.current = controller;
    const requestId = ++rootRequestSeq.current;

    setLoading(true);
    setError(null);
    try {
      const payload = await fetchFolder("", {
        limit: SERVER_PAGE_SIZE,
        mode: "light",
        signal: controller.signal,
      });
      if (requestId !== rootRequestSeq.current) return;
      previewCache.current.clear();
      setFolder(payload);
      setCategoryPreview(null);
      setCategoryPath(null);
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : "加载失败";
      setError(message);
    } finally {
      if (requestId === rootRequestSeq.current) {
        setLoading(false);
      }
    }
  }, [resetRootPreviewQueue]);

  const handleSelectCategory = useCallback(async (path: string) => {
    setCategoryPath(path);
    setCategoryLoading(true);
    setCategoryError(null);
    setCategoryHasMore(false);
    setCategoryLoadingMore(false);
    categoryLoadMoreSeq.current += 1;

    const requestId = ++categoryRequestSeq.current;
    categoryAbortRef.current?.abort();
    const controller = new AbortController();
    categoryAbortRef.current = controller;

    try {
      const cached = previewCache.current.get(path);
      if (cached) {
        if (requestId !== categoryRequestSeq.current) return;
        setCategoryPreview(cached.payload);
        setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
        setCategoryHasMore(Boolean(cached.nextCursor));
        return;
      }

      const payload = await fetchFolder(path, {
        limit: SERVER_PAGE_SIZE,
        mode: "full",
        signal: controller.signal,
      });
      if (requestId !== categoryRequestSeq.current) return;

      const entry: CategoryCacheEntry = {
        payload: { ...payload, media: [...payload.media] },
        nextCursor: payload.nextCursor,
      };
      previewCache.current.set(path, entry);
      setCategoryPreview(entry.payload);
      setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
      setCategoryHasMore(Boolean(entry.nextCursor));
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
      setCategoryPreview(null);
      setCategoryHasMore(false);
    } finally {
      if (requestId === categoryRequestSeq.current) {
        setCategoryLoading(false);
      }
    }
  }, []);

  const loadMoreCategory = useCallback(async () => {
    if (!categoryPath || categoryLoadingMore || !categoryHasMore) return;
    const cached = previewCache.current.get(categoryPath);
    if (!cached?.nextCursor) {
      setCategoryHasMore(false);
      return;
    }

    const expectedCursor = cached.nextCursor;
    const requestId = ++categoryLoadMoreSeq.current;
    setCategoryLoadingMore(true);
    setCategoryError(null);

    try {
      const payload = await fetchFolder(categoryPath, {
        cursor: expectedCursor,
        limit: SERVER_PAGE_SIZE,
        mode: "full",
      });
      if (requestId !== categoryLoadMoreSeq.current) return;

      const latest = previewCache.current.get(categoryPath);
      if (!latest || latest.nextCursor !== expectedCursor) return;

      const mergedPayload: FolderPayload = {
        ...latest.payload,
        folder: payload.folder,
        breadcrumb: payload.breadcrumb,
        subfolders: payload.subfolders,
        totals: payload.totals,
        media: mergeMediaByPath(latest.payload.media, payload.media),
      };

      previewCache.current.set(categoryPath, {
        payload: mergedPayload,
        nextCursor: payload.nextCursor,
      });

      setCategoryPreview(mergedPayload);
      setCategoryHasMore(Boolean(payload.nextCursor));
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
    } finally {
      if (requestId === categoryLoadMoreSeq.current) {
        setCategoryLoadingMore(false);
      }
    }
  }, [categoryHasMore, categoryLoadingMore, categoryPath]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("mv-theme", theme);
    window.localStorage.setItem("mv-theme-manual", manualTheme ? "true" : "false");
  }, [theme, manualTheme]);

  useEffect(() => {
    window.localStorage.setItem("mv-low-performance", lowPerformanceMode ? "true" : "false");
  }, [lowPerformanceMode]);

  useEffect(() => {
    if (manualTheme) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [manualTheme]);

  useEffect(() => {
    void loadRoot();
    return () => {
      rootAbortRef.current?.abort();
      categoryAbortRef.current?.abort();
      resetRootPreviewQueue();
    };
  }, [loadRoot, resetRootPreviewQueue]);

  useEffect(() => {
    if (folder?.subfolders.length && !categoryPath) {
      void handleSelectCategory(folder.subfolders[0].path);
    }
  }, [folder, categoryPath, handleSelectCategory]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    if (selected) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = originalOverflow;
    }
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [selected]);

  useEffect(() => {
    if (!filteredAccounts.length) return;
    const exists = filteredAccounts.some((item) => item.path === categoryPath);
    if (!exists) {
      void handleSelectCategory(filteredAccounts[0].path);
    }
  }, [filteredAccounts, categoryPath, handleSelectCategory]);

  useEffect(() => {
    if (!filteredAccounts.length) return;
    enqueueRootPreviewPaths(
      filteredAccounts.slice(0, ROOT_PREVIEW_BATCH_SIZE).map((item) => item.path)
    );
  }, [enqueueRootPreviewPaths, filteredAccounts]);

  useEffect(() => {
    const root = categoryListRef.current;
    if (!root || !filteredAccounts.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visiblePaths = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.path)
          .filter((value): value is string => Boolean(value));
        enqueueRootPreviewPaths(visiblePaths);
      },
      {
        root,
        rootMargin: "160px 0px",
      }
    );

    const cards = root.querySelectorAll<HTMLButtonElement>(".category-item[data-path]");
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [enqueueRootPreviewPaths, filteredAccounts]);

  useEffect(() => {
    const target = categoryLoadMoreRef.current;
    const root = previewScrollRef.current;
    if (!target || !categoryPreview) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;

        if (visibleCategoryMedia.length < filteredCategoryMedia.length) {
          setCategoryVisibleCount((prev) =>
            Math.min(prev + PAGE_STEP, filteredCategoryMedia.length)
          );
          return;
        }

        if (categoryHasMore && !categoryLoadingMore) {
          void loadMoreCategory();
        }
      },
      { root: root ?? null, rootMargin: "200px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    categoryHasMore,
    categoryLoadingMore,
    categoryPreview,
    filteredCategoryMedia.length,
    loadMoreCategory,
    visibleCategoryMedia.length,
  ]);

  useEffect(() => {
    const el = previewScrollRef.current;
    if (!el) {
      setShowScrollTop(false);
      return;
    }
    const onScroll = () => setShowScrollTop(el.scrollTop > 200);
    el.addEventListener("scroll", onScroll);
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [categoryPreview, mediaFilter, sortMode, mediaSort]);

  useEffect(() => {
    if (!effectsEnabled) {
      setHeartCursorVisible(false);
      return;
    }

    const updateOverlay = () => {
      heartCursorRaf.current = null;
      const el = heartCursorRef.current;
      if (!el) return;
      el.style.left = `${heartCursorPos.current.x}px`;
      el.style.top = `${heartCursorPos.current.y}px`;
    };

    const onMove = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest(".heart-target");
      const show = Boolean(target);
      if (show !== heartCursorVisible) {
        setHeartCursorVisible(show);
      }
      if (!show) return;
      heartCursorPos.current = {
        x: event.clientX + CURSOR_OFFSET.x,
        y: event.clientY + CURSOR_OFFSET.y,
      };
      if (heartCursorRaf.current === null) {
        heartCursorRaf.current = requestAnimationFrame(updateOverlay);
      }
    };

    const onLeave = () => {
      setHeartCursorVisible(false);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      if (heartCursorRaf.current) cancelAnimationFrame(heartCursorRaf.current);
    };
  }, [effectsEnabled, heartCursorVisible]);

  useEffect(() => {
    if (!effectsEnabled) return;
    const color = `hsl(${heartHue},85%,70%)`;
    const cursor = makeHeartCursor(heartHue);
    document.documentElement.style.setProperty("--cursor-heart", cursor);
    document.documentElement.style.setProperty("--cursor-heart-fill", color);
  }, [effectsEnabled, heartHue]);

  return (
    <div className="page">
      <ParticleField enabled={effectsEnabled} cursorOffset={CURSOR_OFFSET} />
      <HeartPulseLayer
        enabled={effectsEnabled}
        hoveredCardRef={hoveredCardRef}
        onHueChange={setHeartHue}
        cursorOffset={CURSOR_OFFSET}
        pulseOffsetY={HEART_PULSE_OFFSET_Y}
      />
      {effectsEnabled && heartCursorVisible && (
        <div
          ref={heartCursorRef}
          className="cursor-heart-overlay"
          style={{
            left: heartCursorPos.current.x,
            top: heartCursorPos.current.y,
            transform: "translate(-50%, -50%)",
          }}
        />
      )}

      <div className={`microbar microbar--fixed ${selected ? "microbar--hidden" : ""}`}>
        <div className="microbar__left">
          <div className="badge badge--split badge--brand">
            <span className="badge__left">Tiny Media Viewer</span>
            <span className="badge__right">{versionLabel}</span>
          </div>
          <div className="badge badge--split badge--ts">
            <span className="badge__left">TypeScript</span>
            <span className="badge__right">5.9</span>
          </div>
          <div className="badge badge--split badge--react">
            <span className="badge__left">React</span>
            <span className="badge__right">19</span>
          </div>
        </div>
        <div className="microbar__right">
          <button
            className="theme-toggle"
            onClick={() => {
              setManualTheme(true);
              setTheme(theme === "light" ? "dark" : "light");
            }}
            aria-label="切换主题"
          >
            {theme === "light" ? "☀️" : "🌙"}
          </button>
          <button
            className="theme-toggle"
            onClick={() => setLowPerformanceMode((prev) => !prev)}
            aria-pressed={lowPerformanceMode}
            aria-label="切换低性能模式"
          >
            {lowPerformanceMode ? "省" : "效"}
          </button>
        </div>
      </div>

      <section className="section">
        <div className="controls condensed">
          <div className="controls__actions wide">
            <div className="toggle-switch mini sort-toggle">
              <div
                className="toggle-indicator"
                data-side={sortMode === "time" ? "left" : "right"}
              />
              <button
                className={`toggle-option ${sortMode === "time" ? "active" : ""}`}
                onClick={() => setSortMode("time")}
                aria-pressed={sortMode === "time"}
              >
                按时间
              </button>
              <button
                className={`toggle-option ${sortMode === "name" ? "active" : ""}`}
                onClick={() => setSortMode("name")}
                aria-pressed={sortMode === "name"}
              >
                按名称
              </button>
            </div>
            <input
              type="search"
              placeholder="筛选账号名称..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="search-input"
            />
            <div className="controls__cluster">
              <div className="meter-pill" aria-label="媒体计数">
                <div className="meter-pill__fill" style={{ width: `${meterPercent}%` }} />
                <span className="meter-pill__text">
                  {visibleCount} / {totalMedia} 媒体
                </span>
              </div>
              <div className="toggle-switch tiny">
                <div
                  className="toggle-indicator"
                  data-side={mediaSort === "asc" ? "left" : "right"}
                />
                <button
                  className={`toggle-option ${mediaSort === "asc" ? "active" : ""}`}
                  onClick={() => setMediaSort("asc")}
                  aria-pressed={mediaSort === "asc"}
                >
                  按时间+
                </button>
                <button
                  className={`toggle-option ${mediaSort === "desc" ? "active" : ""}`}
                  onClick={() => setMediaSort("desc")}
                  aria-pressed={mediaSort === "desc"}
                >
                  按时间-
                </button>
              </div>
              <div className="toggle-switch small media-toggle">
                <div
                  className="toggle-indicator"
                  data-side={mediaFilter === "image" ? "left" : "right"}
                />
                <button
                  className={`toggle-option ${mediaFilter === "image" ? "active" : ""}`}
                  onClick={() => setMediaFilter("image")}
                  aria-pressed={mediaFilter === "image"}
                >
                  图片
                </button>
                <button
                  className={`toggle-option ${mediaFilter === "video" ? "active" : ""}`}
                  onClick={() => setMediaFilter("video")}
                  aria-pressed={mediaFilter === "video"}
                >
                  视频
                </button>
              </div>
            </div>
            {loading && <span className="pill">加载中...</span>}
            {error && <span className="pill error">{error}</span>}
          </div>
        </div>

        <div className="category-layout">
          <div className="category-list" ref={categoryListRef}>
            {filteredAccounts.map((item) => (
              <button
                key={item.path}
                data-path={item.path}
                className={`category-item ${categoryPath === item.path ? "active" : ""}`}
                onClick={() => {
                  void handleSelectCategory(item.path);
                }}
              >
                <div className="category-item__title">{item.name}</div>
                <div className="category-item__meta">
                  {item.countsReady ? (
                    <>
                      <span>🖼️ {item.counts.images + item.counts.gifs}</span>
                      <span>🎞️ {item.counts.videos}</span>
                    </>
                  ) : (
                    <span>统计中...</span>
                  )}
                </div>
              </button>
            ))}
            {!filteredAccounts.length && !loading && <div className="empty">没有匹配的账号</div>}
          </div>

          <div className="category-panel">
            <div className="category-preview" ref={previewScrollRef}>
              {categoryLoading && <div className="empty">加载账号媒体...</div>}
              {categoryError && <div className="empty">{categoryError}</div>}

              {!categoryLoading && !categoryError && categoryPreview && (
                <>
                  <div className="media-grid">
                    {visibleCategoryMedia.map((item) => (
                      <button
                        key={`${categoryPreview.folder.path}-${item.path}`}
                        className="media-card heart-target"
                        onClick={() => setSelected(item)}
                        onMouseEnter={(event) => {
                          hoveredCardRef.current = event.currentTarget;
                        }}
                        onMouseLeave={(event) => {
                          if (hoveredCardRef.current === event.currentTarget) {
                            hoveredCardRef.current = null;
                          }
                          event.currentTarget.classList.remove("heart-beat");
                        }}
                      >
                        {item.kind === "video" ? (
                          <video muted playsInline preload="metadata">
                            <source src={item.url} />
                          </video>
                        ) : (
                          <img src={item.url} alt={item.name} loading="lazy" />
                        )}
                        <div className="media-card__meta">
                          <div>
                            <p className="media-title">{item.name}</p>
                            <p className="muted">
                              {formatBytes(item.size)} · {formatDate(item.modified)}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                    {!visibleCategoryMedia.length && (
                      <div className="empty">该账号暂无符合过滤条件的媒体</div>
                    )}
                  </div>

                  {(visibleCategoryMedia.length < filteredCategoryMedia.length ||
                    categoryHasMore) && (
                    <div className="load-more">
                      <button
                        className="primary-button"
                        disabled={categoryLoadingMore}
                        onClick={() => {
                          if (visibleCategoryMedia.length < filteredCategoryMedia.length) {
                            setCategoryVisibleCount((prev) =>
                              Math.min(prev + PAGE_STEP, filteredCategoryMedia.length)
                            );
                            return;
                          }
                          void loadMoreCategory();
                        }}
                      >
                        {categoryLoadingMore
                          ? "加载中..."
                          : visibleCategoryMedia.length < filteredCategoryMedia.length
                            ? "加载更多"
                            : "从服务加载更多"}
                      </button>
                      <div ref={categoryLoadMoreRef} style={{ height: 1 }} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <MediaPreviewModal
        media={selected}
        onClose={() => setSelected(null)}
        onPrev={() => {
          if (!selected) return;
          const idx = filteredCategoryMedia.findIndex((item) => item.path === selected.path);
          if (idx > 0) {
            setSelected(filteredCategoryMedia[idx - 1]);
          }
        }}
        onNext={() => {
          if (!selected) return;
          const idx = filteredCategoryMedia.findIndex((item) => item.path === selected.path);
          const next = idx + 1;
          if (idx !== -1 && next < filteredCategoryMedia.length) {
            setSelected(filteredCategoryMedia[next]);
          }
        }}
        hasPrev={selectedIndex > 0}
        hasNext={selectedIndex > -1 && selectedIndex < filteredCategoryMedia.length - 1}
      />

      {showScrollTop && (
        <button
          className="scroll-top"
          onClick={() => {
            const el = previewScrollRef.current;
            if (el) {
              el.scrollTo({ top: 0, behavior: "smooth" });
            } else {
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
          }}
          aria-label="回到顶部"
        >
          ↑
        </button>
      )}
    </div>
  );
}

export default App;
