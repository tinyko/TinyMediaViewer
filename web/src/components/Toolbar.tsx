import { memo } from "react";
import type { EffectsMode } from "../types";

type Theme = "light" | "dark";

interface ToolbarProps {
  versionLabel: string;
  versionFingerprint: string;
  theme: Theme;
  onToggleTheme: () => void;
  effectsMode: EffectsMode;
  onCycleEffectsMode: () => void;
  rendererLabel: string;
  onToggleRenderer: () => void;
  perfNotice: string | null;
  loading: boolean;
  error: string | null;
  requiresAuth: boolean;
  onReauthenticate: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  sortMode: "time" | "name" | "favorite";
  setSortMode: (mode: "time" | "name" | "favorite") => void;
  search: string;
  setSearch: (value: string) => void;
  filteredCount: number;
  totalMedia: number;
  meterPercent: number;
  mediaSort: "asc" | "desc";
  setMediaSort: (value: "asc" | "desc") => void;
  mediaFilter: "image" | "video";
  setMediaFilter: (value: "image" | "video") => void;
}

const modeLabel: Record<EffectsMode, string> = {
  auto: "自",
  off: "省",
  full: "效",
};

export const Toolbar = memo(function Toolbar(props: ToolbarProps) {
  const {
    versionLabel,
    versionFingerprint,
    theme,
    onToggleTheme,
    effectsMode,
    onCycleEffectsMode,
    rendererLabel,
    onToggleRenderer,
    perfNotice,
    loading,
    error,
    requiresAuth,
    onReauthenticate,
    refreshing,
    onRefresh,
    sortMode,
    setSortMode,
    search,
    setSearch,
    filteredCount,
    totalMedia,
    meterPercent,
    mediaSort,
    setMediaSort,
    mediaFilter,
    setMediaFilter,
  } = props;

  return (
    <>
      <div className="microbar microbar--fixed">
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
          <div className="badge badge--split badge--build" title={versionFingerprint}>
            <span className="badge__left">Build</span>
            <span className="badge__right">{versionFingerprint}</span>
          </div>
          {perfNotice && <span className="pill error">{perfNotice}</span>}
        </div>
        <div className="microbar__right">
          <button className="theme-toggle" onClick={onToggleTheme} aria-label="切换主题">
            {theme === "light" ? "☀️" : "🌙"}
          </button>
          <button
            className="theme-toggle"
            onClick={onCycleEffectsMode}
            aria-label="切换特效模式"
            title={`特效模式: ${effectsMode}`}
          >
            {modeLabel[effectsMode]}
          </button>
          <button
            className="theme-toggle"
            onClick={onToggleRenderer}
            aria-label="切换渲染器"
            title={`渲染器: ${rendererLabel}`}
          >
            {rendererLabel}
          </button>
        </div>
      </div>

      <div className="controls condensed">
        <div className="controls__actions wide">
          <div className="toggle-switch mini triple sort-toggle">
            <div
              className="toggle-indicator"
              data-index={
                sortMode === "time" ? "0" : sortMode === "name" ? "1" : "2"
              }
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
            <button
              className={`toggle-option ${sortMode === "favorite" ? "active" : ""}`}
              onClick={() => setSortMode("favorite")}
              aria-pressed={sortMode === "favorite"}
            >
              按收藏
            </button>
          </div>

          <input
            type="search"
            placeholder="筛选账号名称..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="search-input"
          />

          <button
            className="ghost-button"
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "刷新中..." : "刷新"}
          </button>

          <div className="controls__cluster">
            <div className="meter-pill" aria-label="媒体计数">
              <div className="meter-pill__fill" style={{ width: `${meterPercent}%` }} />
              <span className="meter-pill__text">
                {filteredCount} / {totalMedia} 媒体
              </span>
            </div>
            <div className="toggle-switch tiny">
              <div className="toggle-indicator" data-side={mediaSort === "asc" ? "left" : "right"} />
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
          {requiresAuth && (
            <button className="ghost-button" type="button" onClick={onReauthenticate}>
              手动重新登录
            </button>
          )}
        </div>
      </div>
    </>
  );
});
