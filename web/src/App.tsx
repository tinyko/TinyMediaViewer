import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import "./features/effects/effects.css";
import type { MediaItem } from "./types";
import { MediaPreviewModal } from "./features/preview/MediaPreviewModal";
import { useModalNavigation } from "./features/preview/useModalNavigation";
import { EffectsStage } from "./features/effects/EffectsStage";
import { useThemeAndPerf } from "./features/ui/useThemeAndPerf";
import { useViewerPreferences } from "./features/ui/useViewerPreferences";
import { useAppInteractions } from "./features/ui/useAppInteractions";
import { SystemUsageModal } from "./features/systemUsage/SystemUsageModal";
import { useViewerSession } from "./features/session/useViewerSession";
import { Toolbar } from "./components/Toolbar";
import { MainContent } from "./components/MainContent";

const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;

const APP_VERSION = import.meta.env.VITE_TMV_APP_VERSION ?? "0.1.0";
const APP_SHORT_COMMIT = import.meta.env.VITE_TMV_SHORT_COMMIT ?? "dev";
const APP_BUILD_TIME = import.meta.env.VITE_TMV_BUILD_TIME ?? "unknown";

function App() {
  const viewerPreferencesQuery = useViewerPreferences();
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const preferencesReady =
    viewerPreferencesQuery.status === "success" || viewerPreferencesQuery.error != null;
  const {
    theme,
    setTheme,
    setManualTheme,
    manualTheme,
    effectsMode,
    cycleEffectsMode,
    effectsRenderer,
    resolvedRenderer,
    toggleRenderer,
    reportResolvedRenderer,
    effectsEnabled,
    perfNotice,
    reportVisibleCards,
    preferencesHydrated: themePreferencesHydrated,
  } = useThemeAndPerf({
    initialPreferences: preferencesReady ? (viewerPreferencesQuery.data ?? null) : null,
    preferencesReady,
  });
  const {
    loading,
    search,
    setSearch,
    mediaFilter,
    setMediaFilter,
    sortMode,
    setSortMode,
    mediaSort,
    setMediaSort,
    refreshing,
    rootStore,
    filteredAccountPaths,
    categoryPath,
    categoryPreview,
    categoryMedia,
    visibleMedia,
    categoryLoading,
    categoryLoadingMore,
    categoryHasMore,
    categoryError,
    showSystemUsage,
    systemUsageQuery,
    filteredCount,
    totalMedia,
    meterPercent,
    toolbarError,
    requiresAuth,
    onVisibleCategoryPathsChange,
    onSelectCategory,
    onRandomizeAccounts,
    onRandomizeMedia,
    onReachEnd,
    onRefresh,
    onReauthenticate,
    onOpenSystemUsage,
    onCloseSystemUsage,
    onRefreshSystemUsage,
    onToggleFavorite,
    resetRootPreviewQueue,
  } = useViewerSession({
    persistedViewerPreferences: viewerPreferencesQuery.data,
    preferencesReady,
    preferenceLoadError: viewerPreferencesQuery.error,
    persistViewerPreferences: viewerPreferencesQuery.persist,
    persistPreferenceError: viewerPreferencesQuery.persistError,
    themePreferences: {
      theme,
      manualTheme,
      effectsMode,
      effectsRenderer,
    },
    themePreferencesReady: themePreferencesHydrated,
  });

  const versionLabel = `v${APP_VERSION}`;
  const versionFingerprint = `${versionLabel}+${APP_SHORT_COMMIT} (${APP_BUILD_TIME})`;

  const onVisibleCardsChange = useCallback(
    (count: number) => reportVisibleCards(count),
    [reportVisibleCards]
  );
  const onSetMediaSort = useCallback((value: typeof mediaSort) => {
    setMediaSort(value);
  }, [setMediaSort]);
  const onToggleTheme = useCallback(() => {
    setManualTheme(true);
    setTheme(theme === "light" ? "dark" : "light");
  }, [setManualTheme, setTheme, theme]);
  const activeSelected = useMemo(() => {
    if (!selected) return null;
    if (!categoryPath) {
      return null;
    }
    if (!categoryMedia.length) {
      return categoryPreview ? selected : null;
    }

    const updated = categoryMedia.find((item) => item.path === selected.path);
    if (!updated) {
      return null;
    }

    if (
      updated.modified !== selected.modified ||
      updated.size !== selected.size ||
      updated.url !== selected.url ||
      updated.name !== selected.name
    ) {
      return updated;
    }

    return selected;
  }, [categoryMedia, categoryPath, categoryPreview, selected]);

  const scrollTrackingKey = `${categoryPreview?.folder.path ?? "-"}|${mediaFilter}|${mediaSort}|${sortMode}`;
  const {
    showScrollTop,
    heartCursorVisible,
    heartCursorRef,
    hoveredCardRef,
    onHeartHueChange,
    scrollToTop,
  } = useAppInteractions({
    selected: activeSelected,
    effectsEnabled,
    previewScrollRef,
    resetRootPreviewQueue,
    scrollTrackingKey,
  });
  const { onClose, onPrev, onNext, hasPrev, hasNext } = useModalNavigation({
    selected: activeSelected,
    media: categoryMedia,
    onSelect: setSelected,
  });

  return (
    <div className="page">
      <EffectsStage
        enabled={effectsEnabled}
        requestedRenderer={effectsRenderer}
        hoveredCardRef={hoveredCardRef}
        onHueChange={onHeartHueChange}
        onResolvedRendererChange={reportResolvedRenderer}
        cursorOffset={CURSOR_OFFSET}
        pulseOffsetY={HEART_PULSE_OFFSET_Y}
      />
      {effectsEnabled && heartCursorVisible && (
        <div
          ref={heartCursorRef}
          className="cursor-heart-overlay"
          style={{ transform: "translate(-50%, -50%)" }}
        />
      )}

      <Toolbar
        versionLabel={versionLabel}
        versionFingerprint={versionFingerprint}
        theme={theme}
        onToggleTheme={onToggleTheme}
        effectsMode={effectsMode}
        onCycleEffectsMode={cycleEffectsMode}
        rendererLabel={
          effectsRenderer === "webgpu" ? (resolvedRenderer === "webgpu" ? "WG" : "WG×") : "2D"
        }
        onToggleRenderer={toggleRenderer}
        perfNotice={perfNotice}
        loading={loading}
        error={toolbarError}
        requiresAuth={requiresAuth}
        onReauthenticate={onReauthenticate}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onOpenSystemUsage={onOpenSystemUsage}
        sortMode={sortMode}
        setSortMode={setSortMode}
        onRandomizeAccounts={onRandomizeAccounts}
        search={search}
        setSearch={setSearch}
        filteredCount={filteredCount}
        totalMedia={totalMedia}
        meterPercent={meterPercent}
        mediaSort={mediaSort}
        setMediaSort={onSetMediaSort}
        onRandomizeMedia={onRandomizeMedia}
        mediaFilter={mediaFilter}
        setMediaFilter={setMediaFilter}
      />

      <MainContent
        accountPaths={filteredAccountPaths}
        rootStore={rootStore}
        categoryPath={categoryPath}
        loading={loading}
        onSelectCategory={onSelectCategory}
        onToggleFavorite={onToggleFavorite}
        onVisibleCategoryPathsChange={onVisibleCategoryPathsChange}
        previewScrollRef={previewScrollRef}
        categoryLoading={categoryLoading}
        categoryError={requiresAuth ? "访问已失效，正在跳转登录..." : categoryError}
        categoryPreview={categoryPreview}
        visibleCategoryMedia={visibleMedia}
        filteredCategoryMediaCount={filteredCount}
        categoryHasMore={categoryHasMore}
        categoryLoadingMore={categoryLoadingMore}
        hoveredCardRef={hoveredCardRef}
        onSelectMedia={setSelected}
        onReachEnd={onReachEnd}
        onVisibleCardsChange={onVisibleCardsChange}
      />

      <MediaPreviewModal
        media={activeSelected}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
      />

      <SystemUsageModal
        open={showSystemUsage}
        report={systemUsageQuery.data ?? null}
        loading={systemUsageQuery.isLoading || systemUsageQuery.isFetching}
        error={
          systemUsageQuery.error instanceof Error
            ? systemUsageQuery.error.message
            : systemUsageQuery.error
              ? "系统占用统计失败"
              : null
        }
        onClose={onCloseSystemUsage}
        onRefresh={onRefreshSystemUsage}
      />

      {showScrollTop && (
        <button className="scroll-top" onClick={scrollToTop} aria-label="回到顶部">
          ↑
        </button>
      )}
    </div>
  );
}

export default App;
