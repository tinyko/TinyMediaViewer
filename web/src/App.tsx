import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { fetchFolder } from "./api";
import type { FolderPayload, MediaItem, MediaKind } from "./types";
import { MediaPreviewModal } from "./components/MediaPreviewModal";
import { formatBytes, formatDate } from "./utils";

type Theme = "light" | "dark";

function App() {
  const getInitialTheme = (): Theme => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem("mv-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  const [folder, setFolder] = useState<FolderPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const [categoryPreview, setCategoryPreview] = useState<FolderPayload | null>(null);
  const [categoryVisibleCount, setCategoryVisibleCount] = useState(48);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<MediaKind>("image");
  const [sortMode, setSortMode] = useState<"time" | "name">("time");
  const [mediaSort, setMediaSort] = useState<"asc" | "desc">("desc");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [manualTheme, setManualTheme] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("mv-theme-manual") === "true";
  });
  const previewCache = useRef(new Map<string, FolderPayload>());
  const categoryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const versionLabel = "v0.3";

  const filteredAccounts = useMemo(() => {
    if (!folder) return [];
    const items = folder.subfolders.filter((item) => {
      const matchesText = item.name.toLowerCase().includes(search.toLowerCase());
      const hasKind =
        (mediaFilter === "image" && item.counts.images > 0) ||
        (mediaFilter === "video" && item.counts.videos > 0);
      return matchesText && hasKind;
    });
    return items.sort((a, b) => {
      if (sortMode === "name") {
        return a.name.localeCompare(b.name);
      }
      return b.modified - a.modified;
    });
  }, [folder, search, mediaFilter, sortMode]);

  const categoryMedia = categoryPreview?.media ?? [];
  const getMediaTimestamp = (item: MediaItem) => {
    const match = item.name.match(/_(\d{8})_(\d{6})/);
    if (match) {
      const [date, time] = [match[1], match[2]];
      const year = Number(date.slice(0, 4));
      const month = Number(date.slice(4, 6)) - 1;
      const day = Number(date.slice(6, 8));
      const hour = Number(time.slice(0, 2));
      const minute = Number(time.slice(2, 4));
      const second = Number(time.slice(4, 6));
      return new Date(year, month, day, hour, minute, second).getTime();
    }
    return item.modified;
  };
  const filteredCategoryMedia = useMemo(() => {
    const filtered = categoryMedia.filter((item) => item.kind === mediaFilter);
    return [...filtered].sort((a, b) =>
      mediaSort === "asc"
        ? getMediaTimestamp(a) - getMediaTimestamp(b)
        : getMediaTimestamp(b) - getMediaTimestamp(a)
    );
  }, [categoryMedia, mediaFilter, mediaSort]);
  const visibleCategoryMedia = filteredCategoryMedia.slice(0, categoryVisibleCount);
  const selectedIndex = selected
    ? filteredCategoryMedia.findIndex((item) => item.path === selected.path)
    : -1;

  const loadPreview = async (path: string) => {
    if (previewCache.current.has(path)) {
      return previewCache.current.get(path)!;
    }
    const payload = await fetchFolder(path);
    previewCache.current.set(path, payload);
    return payload;
  };

  const loadRoot = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchFolder("");
      setFolder(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载失败";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCategory = async (path: string) => {
    setCategoryPath(path);
    setCategoryLoading(true);
    setCategoryError(null);
    try {
      const payload = await loadPreview(path);
      setCategoryPreview(payload);
      setCategoryVisibleCount(48);
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
    } finally {
      setCategoryLoading(false);
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("mv-theme", theme);
    window.localStorage.setItem("mv-theme-manual", manualTheme ? "true" : "false");
  }, [theme, manualTheme]);

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
    loadRoot();
  }, []);

  useEffect(() => {
    if (folder?.subfolders.length && !categoryPath) {
      handleSelectCategory(folder.subfolders[0].path);
    }
  }, [folder, categoryPath]);

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
      handleSelectCategory(filteredAccounts[0].path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredAccounts]);

  useEffect(() => {
    const target = categoryLoadMoreRef.current;
    if (!target || !categoryPreview) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setCategoryVisibleCount((prev) =>
            Math.min(prev + 32, filteredCategoryMedia.length)
          );
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [categoryPreview, filteredCategoryMedia.length]);

  useEffect(() => {
    const onScroll = () => {
      const scrolled = window.scrollY > 200;
      setShowScrollTop(scrolled);
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="page">
      <div
        className={`microbar microbar--fixed ${
          selected ? "microbar--hidden" : ""
        }`}
      >
        <div className="microbar__left">
          <div className="badge badge--split badge--brand">
            <span className="badge__left">Media Viewer</span>
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
        </div>
      </div>
      <section className="section">
        <div className="controls condensed">
          <div className="controls__actions wide">
            <div className="toggle-switch small sort-toggle">
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
            {loading && <span className="pill">加载中...</span>}
            {error && <span className="pill error">{error}</span>}
          </div>
        </div>

        <div className="category-layout">
          <div className="category-list">
            {filteredAccounts.map((item) => (
              <button
                key={item.path}
                className={`category-item ${
                  categoryPath === item.path ? "active" : ""
                }`}
                onClick={() => handleSelectCategory(item.path)}
              >
                <div className="category-item__title">{item.name}</div>
                <div className="category-item__meta">
                  <span>🖼️ {item.counts.images}</span>
                  <span>🎞️ {item.counts.videos}</span>
                </div>
              </button>
            ))}
            {!filteredAccounts.length && !loading && (
              <div className="empty">没有匹配的账号</div>
            )}
          </div>

          <div className="category-preview">
            {categoryLoading && <div className="empty">加载账号媒体...</div>}
            {categoryError && <div className="empty">{categoryError}</div>}
            {!categoryLoading && !categoryError && categoryPreview && (
              <>
                <div className="category-preview__header">
                  <div>
                    <h3>{categoryPreview.folder.name}</h3>
                    <p className="muted">
                      {filteredCategoryMedia.length} / {categoryPreview.totals.media} 媒体
                    </p>
                  </div>
                  <div className="toggle-switch wide">
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
                </div>

                <div className="media-grid">
          {visibleCategoryMedia.map((item) => (
            <button
              key={`${categoryPreview.folder.path}-${item.path}`}
              className="media-card"
              onClick={() => {
                setSelected(item);
              }}
              title={item.name}
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
                {visibleCategoryMedia.length < filteredCategoryMedia.length && (
                  <div className="load-more">
                    <button
                      className="primary-button"
                      onClick={() =>
                        setCategoryVisibleCount((prev) =>
                          Math.min(prev + 32, filteredCategoryMedia.length)
                        )
                      }
                    >
                      加载更多
                    </button>
                    <div ref={categoryLoadMoreRef} style={{ height: 1 }} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      <MediaPreviewModal
        media={selected}
        onClose={() => {
          setSelected(null);
        }}
        onPrev={() => {
          if (!selected) return;
          const idx = filteredCategoryMedia.findIndex(
            (item) => item.path === selected.path
          );
          if (idx > 0) {
            setSelected(filteredCategoryMedia[idx - 1]);
          }
        }}
        onNext={() => {
          if (!selected) return;
          const idx = filteredCategoryMedia.findIndex(
            (item) => item.path === selected.path
          );
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
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="回到顶部"
        >
          ↑
        </button>
      )}
    </div>
  );
}

export default App;
