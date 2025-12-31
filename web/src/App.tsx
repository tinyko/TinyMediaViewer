import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import "./App.css";
import { fetchFolder } from "./api";
import type { FolderPayload, MediaItem, MediaKind } from "./types";
import { MediaPreviewModal } from "./components/MediaPreviewModal";
import { formatBytes, formatDate } from "./utils";

type Theme = "light" | "dark";
const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;
const makeHeartCursor = (hue: number) => {
  const color = `hsl(${hue},85%,70%)`;
  const stroke = `hsl(${hue},90%,92%)`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><path d='M16 29s-9-5.7-12-12c-3-6.3 4-13 12-5.5C24-1 31 5.7 28 12 25 18.3 16 29 16 29z' fill='${color}' stroke='${stroke}' stroke-width='1.6' stroke-linejoin='round'/></svg>`;
  return `url(\"data:image/svg+xml,${encodeURIComponent(svg)}\") 16 16, auto`;
};

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
  const [heartCursor, setHeartCursor] = useState<{ x: number; y: number; show: boolean }>({
    x: 0,
    y: 0,
    show: false,
  });
  const [heartHue, setHeartHue] = useState(0);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [manualTheme, setManualTheme] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("mv-theme-manual") === "true";
  });
  const previewCache = useRef(new Map<string, FolderPayload>());
  const categoryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const hoveredCardRef = useRef<HTMLButtonElement | null>(null);
  const versionLabel = "v0.5.1";
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);

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
  const totalMedia = categoryPreview?.totals.media ?? 0;
  const visibleCount = filteredCategoryMedia.length;
  const meterPercent = totalMedia ? Math.min(100, (visibleCount / totalMedia) * 100) : 0;
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
    const root = previewScrollRef.current;
    if (!target || !categoryPreview) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setCategoryVisibleCount((prev) =>
            Math.min(prev + 32, filteredCategoryMedia.length)
          );
        }
      },
      { root: root ?? null, rootMargin: "200px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [categoryPreview, filteredCategoryMedia.length]);

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
    const onMove = (event: PointerEvent) => {
      const x = event.clientX + CURSOR_OFFSET.x;
      const y = event.clientY + CURSOR_OFFSET.y;
      const target = (event.target as HTMLElement | null)?.closest(".heart-target");
      setHeartCursor({ x, y, show: Boolean(target) });
    };
    const onLeave = () => setHeartCursor((prev) => (prev.show ? { ...prev, show: false } : prev));
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  useEffect(() => {
    const color = `hsl(${heartHue},85%,70%)`;
    const cursor = makeHeartCursor(heartHue);
    document.documentElement.style.setProperty("--cursor-heart", cursor);
    document.documentElement.style.setProperty("--cursor-heart-fill", color);
  }, [heartHue]);

  return (
    <div className="page">
      <ParticleField />
      <HeartPulseLayer hoveredCardRef={hoveredCardRef} onHueChange={setHeartHue} />
      {heartCursor.show && (
        <div
          className="cursor-heart-overlay"
          style={{
            left: heartCursor.x,
            top: heartCursor.y,
            transform: "translate(-50%, -50%)",
          }}
        />
      )}
      <div
        className={`microbar microbar--fixed ${
          selected ? "microbar--hidden" : ""
        }`}
      >
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
                  onClick={() => {
                    setSelected(item);
                  }}
                  onMouseEnter={(event) => {
                    hoverPointRef.current = {
                      x: event.clientX + CURSOR_OFFSET.x,
                      y: event.clientY + CURSOR_OFFSET.y,
                    };
                    hoveredCardRef.current = event.currentTarget;
                  }}
                  onMouseMove={(event) => {
                    hoverPointRef.current = {
                      x: event.clientX + CURSOR_OFFSET.x,
                      y: event.clientY + CURSOR_OFFSET.y,
                    };
                  }}
                  onMouseLeave={(event) => {
                    hoverPointRef.current = null;
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

function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    type Shape = "circle" | "triangle" | "square";
    let particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      size: number;
      hue: number;
      shape: Shape;
      angle: number;
    }> = [];
    let raf = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const pushParticles = (x: number, y: number, count = 10, hueOverride?: number) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 2 + 0.5;
        const shape: Shape = Math.random() < 0.5 ? "circle" : Math.random() < 0.5 ? "triangle" : "square";
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: Math.random() * 0.6 + 0.5,
          size: Math.random() * 1.5 + 1,
          hue: hueOverride ?? Math.random() * 360,
          shape,
          angle: Math.random() * Math.PI * 2,
        });
      }
      if (particles.length > 800) {
        particles = particles.slice(-800);
      }
    };

    const handlePointer = (event: PointerEvent) => {
      pushParticles(
        event.clientX + CURSOR_OFFSET.x,
        event.clientY + CURSOR_OFFSET.y,
        8
      );
    };

    const handleTouch = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch) {
        pushParticles(
          touch.clientX + CURSOR_OFFSET.x,
          touch.clientY + CURSOR_OFFSET.y,
          8
        );
      }
    };

    const tick = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const next: typeof particles = [];
      for (const p of particles) {
        const life = p.life - 0.01;
        if (life <= 0) continue;
        const x = p.x + p.vx;
        const y = p.y + p.vy;
        ctx.globalAlpha = life;
        ctx.fillStyle = `hsla(${p.hue}, 85%, 70%, ${life})`;
        ctx.beginPath();
        if (p.shape === "circle") {
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
        } else if (p.shape === "square") {
          const s = p.size * 1.6;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.angle);
          ctx.rect(-s / 2, -s / 2, s, s);
          ctx.restore();
        } else {
          const s = p.size * 2;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.angle);
          ctx.moveTo(0, -s / 2);
          ctx.lineTo(-s / 2, s / 2);
          ctx.lineTo(s / 2, s / 2);
          ctx.closePath();
          ctx.restore();
        }
        ctx.fill();
        next.push({ ...p, x, y, life });
      }
      particles = next;
      raf = requestAnimationFrame(tick);
    };

    const handleBurst = (event: Event) => {
      const detail = (event as CustomEvent<{ x: number; y: number; count?: number; hue?: number }>).detail;
      if (detail) {
        pushParticles(detail.x, detail.y, detail.count ?? 8, detail.hue);
      }
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointer, { passive: true });
    window.addEventListener("touchmove", handleTouch, { passive: true });
    canvas.addEventListener("particle-burst", handleBurst as EventListener);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("touchmove", handleTouch);
      canvas.removeEventListener("particle-burst", handleBurst as EventListener);
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-layer" aria-hidden />;
}

function HeartPulseLayer({
  hoveredCardRef,
  onHueChange,
}: {
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  onHueChange: (hue: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let hearts: Array<{ x: number; y: number; progress: number; hue: number }> =
      [];
    let raf = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const addHeart = (x: number, y: number) => {
      const heartY = y + HEART_PULSE_OFFSET_Y;
      const hue = Math.random() * 360;
      onHueChange(hue);
      hearts.push({ x, y: heartY, progress: 0, hue });
      if (hearts.length > 120) hearts = hearts.slice(-120);
      // trigger a small particle burst synced with the heart beat
      const particleCanvas = document.querySelector(".particle-layer") as HTMLCanvasElement | null;
      if (particleCanvas) {
        const evt = new CustomEvent("particle-burst", { detail: { x, y, count: 60, hue } });
        particleCanvas.dispatchEvent(evt);
      }
      const card = hoveredCardRef.current;
      if (card) {
        const border = `hsl(${hue},85%,70%)`;
        const shadowStrong = `hsla(${hue},85%,70%,0.25)`;
        const shadowMid = `hsla(${hue},85%,70%,0.18)`;
        const shadowWeak = `hsla(${hue},85%,70%,0.12)`;
        card.style.setProperty("--heart-border", border);
        card.style.setProperty("--heart-shadow-strong", shadowStrong);
        card.style.setProperty("--heart-shadow-mid", shadowMid);
        card.style.setProperty("--heart-shadow-weak", shadowWeak);
        card.classList.remove("heart-beat");
        // force reflow to restart animation
        void card.offsetWidth;
        card.classList.add("heart-beat");
      }
    };

    const startHoverPulse = (x: number, y: number) => {
      if (hoverTimerRef.current) {
        return;
      }
      addHeart(x, y);
      hoverTimerRef.current = window.setInterval(() => {
        const point = hoverPointRef.current ?? { x, y };
        addHeart(point.x, point.y);
      }, 700);
    };

    const stopHoverPulse = () => {
      if (hoverTimerRef.current) {
        window.clearInterval(hoverTimerRef.current);
      }
      hoverTimerRef.current = null;
    };

    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const isHeart = target.closest(".heart-target");
      const x = event.clientX + CURSOR_OFFSET.x;
      const y = event.clientY + CURSOR_OFFSET.y;
      hoverPointRef.current = { x, y };
      if (isHeart) {
        if (!hoverTimerRef.current) {
          startHoverPulse(x, y);
        }
      } else {
        hoverPointRef.current = null;
        stopHoverPulse();
      }
    };

    const drawHeart = (x: number, y: number, size: number) => {
      const s = size;
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, -0.6 * s);
      ctx.bezierCurveTo(-s, -0.8 * s, -1.2 * s, -0.1 * s, -0.1 * s, 0.9 * s);
      ctx.bezierCurveTo(1.2 * s, -0.1 * s, s, -0.8 * s, 0, -0.6 * s);
      ctx.closePath();
      ctx.restore();
    };

    const tick = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const next: typeof hearts = [];
      for (const h of hearts) {
        const p = h.progress + 0.02;
        if (p >= 1) continue;
        const scale = 16 + 36 * p;
        ctx.beginPath();
        drawHeart(h.x, h.y, scale);
        ctx.strokeStyle = `hsla(${h.hue}, 85%, 70%, ${1 - p})`;
        ctx.lineWidth = 2 * (1 - p * 0.6);
        ctx.stroke();
        next.push({ ...h, progress: p });
      }
      hearts = next;
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerenter", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerenter", onPointer);
      stopHoverPulse();
    };
  }, []);

  return <canvas ref={canvasRef} className="heart-layer" aria-hidden />;
}
