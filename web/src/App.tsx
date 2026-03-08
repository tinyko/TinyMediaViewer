import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import "./features/effects/effects.css";
import type { MediaItem, ViewerMediaSortMode, ViewerPreferences } from "./types";
import { postFolderFavorite } from "./api";
import { MediaPreviewModal } from "./features/preview/MediaPreviewModal";
import { useModalNavigation } from "./features/preview/useModalNavigation";
import { EffectsStage } from "./features/effects/EffectsStage";
import { useRootFolder } from "./features/root/useRootFolder";
import {
  areFolderPreviewArraysEqual,
  type RootAccountSortMode,
  selectCategorySummary,
  selectFilteredAccounts,
  useRootStoreSelector,
} from "./features/root/rootStore";
import { usePreviewBackfillQueue } from "./features/previews/usePreviewBackfillQueue";
import { useCategoryMedia } from "./features/category/useCategoryMedia";
import { useThemeAndPerf } from "./features/ui/useThemeAndPerf";
import { useViewerPreferences } from "./features/ui/useViewerPreferences";
import { useAppInteractions } from "./features/ui/useAppInteractions";
import { SystemUsageModal } from "./features/systemUsage/SystemUsageModal";
import { useSystemUsageReport } from "./features/systemUsage/useSystemUsageReport";
import { Toolbar } from "./components/Toolbar";
import { MainContent } from "./components/MainContent";

const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;

const APP_VERSION = import.meta.env.VITE_TMV_APP_VERSION ?? "0.1.0";
const APP_SHORT_COMMIT = import.meta.env.VITE_TMV_SHORT_COMMIT ?? "dev";
const APP_BUILD_TIME = import.meta.env.VITE_TMV_BUILD_TIME ?? "unknown";
type MediaSortMode = ViewerMediaSortMode;
const VIEWER_PREFERENCES_SAVE_DEBOUNCE_MS = 250;

const areViewerPreferencesEqual = (
  left: ViewerPreferences | null,
  right: ViewerPreferences
) =>
  left !== null &&
  left.search === right.search &&
  left.sortMode === right.sortMode &&
  left.randomSeed === right.randomSeed &&
  left.mediaSort === right.mediaSort &&
  left.mediaRandomSeed === right.mediaRandomSeed &&
  left.mediaFilter === right.mediaFilter &&
  left.categoryPath === right.categoryPath &&
  left.theme === right.theme &&
  left.manualTheme === right.manualTheme &&
  left.effectsMode === right.effectsMode &&
  left.effectsRenderer === right.effectsRenderer;

function App() {
  const viewerPreferencesQuery = useViewerPreferences();
  const persistedViewerPreferences = viewerPreferencesQuery.data;
  const persistViewerPreferences = viewerPreferencesQuery.persist;
  const [viewerPreferencesHydrated, setViewerPreferencesHydrated] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [sortMode, setSortMode] = useState<RootAccountSortMode>("time");
  const [randomSeed, setRandomSeed] = useState(0);
  const [mediaSort, setMediaSort] = useState<MediaSortMode>("desc");
  const [mediaRandomSeed, setMediaRandomSeed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [showSystemUsage, setShowSystemUsage] = useState(false);

  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const authRedirectedRef = useRef(false);
  const lastSavedViewerPreferencesRef = useRef<ViewerPreferences | null>(null);
  const initialCategoryRestoreAttemptedRef = useRef(false);
  const deferredSearch = useDeferredValue(search);

  const { store: rootStore, loading, error, loadRoot } = useRootFolder({
    enabled: viewerPreferencesHydrated,
  });
  const rootVersion = useRootStoreSelector(rootStore, (state) => state.version);
  const filteredAccounts = useRootStoreSelector(
    rootStore,
    (state) =>
      selectFilteredAccounts(state, {
        search: deferredSearch,
        sortMode,
        mediaFilter,
        randomSeed,
      }),
    areFolderPreviewArraysEqual
  );
  const { enqueueRootPreviewPaths, resetRootPreviewQueue } = usePreviewBackfillQueue({
    rootStore,
  });
  const {
    categoryPath,
    categoryPreview,
    categoryMedia,
    visibleMedia,
    categoryLoading,
    categoryLoadingMore,
    categoryHasMore,
    categoryError,
    handleSelectCategory,
    restoreCategory,
    refreshCategory,
    loadMoreCategory,
    resetCategory,
  } = useCategoryMedia({
    rootVersion,
    mediaFilter,
    mediaSort,
    mediaRandomSeed,
  });
  useEffect(() => {
    if (viewerPreferencesHydrated) return;
    if (persistedViewerPreferences) {
      setSearch(persistedViewerPreferences.search);
      setMediaFilter(persistedViewerPreferences.mediaFilter);
      setSortMode(persistedViewerPreferences.sortMode);
      setRandomSeed(persistedViewerPreferences.randomSeed);
      setMediaSort(persistedViewerPreferences.mediaSort);
      setMediaRandomSeed(persistedViewerPreferences.mediaRandomSeed);
      restoreCategory(persistedViewerPreferences.categoryPath ?? null);
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
      setViewerPreferencesHydrated(true);
      return;
    }
    if (viewerPreferencesQuery.error) {
      setViewerPreferencesHydrated(true);
    }
  }, [
    restoreCategory,
    persistedViewerPreferences,
    viewerPreferencesHydrated,
    viewerPreferencesQuery.error,
  ]);
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
    initialPreferences: viewerPreferencesHydrated ? (persistedViewerPreferences ?? null) : null,
    preferencesReady: viewerPreferencesHydrated,
  });
  const systemUsageQuery = useSystemUsageReport(showSystemUsage);

  const versionLabel = `v${APP_VERSION}`;
  const versionFingerprint = `${versionLabel}+${APP_SHORT_COMMIT} (${APP_BUILD_TIME})`;
  const selectedCategorySummary = useRootStoreSelector(rootStore, (state) =>
    selectCategorySummary(state, categoryPath)
  );
  const preferredInitialCategoryPath = viewerPreferencesHydrated
    ? (persistedViewerPreferences?.categoryPath ?? null)
    : null;
  const selectedCounts = selectedCategorySummary?.countsReady ? selectedCategorySummary.counts : null;
  const totalMedia = selectedCounts
    ? selectedCounts.images + selectedCounts.gifs + selectedCounts.videos
    : categoryPreview?.totals.media ?? 0;
  const filteredCount = selectedCounts
    ? mediaFilter === "image"
      ? selectedCounts.images + selectedCounts.gifs
      : selectedCounts.videos
    : categoryMedia.length;
  const meterPercent = totalMedia ? Math.min(100, (filteredCount / totalMedia) * 100) : 0;

  const onVisibleCategoryPathsChange = useCallback(
    (paths: string[]) => enqueueRootPreviewPaths(paths),
    [enqueueRootPreviewPaths]
  );
  const onVisibleCardsChange = useCallback(
    (count: number) => reportVisibleCards(count),
    [reportVisibleCards]
  );
  const onSelectCategory = useCallback(
    (path: string) => {
      void handleSelectCategory(path);
    },
    [handleSelectCategory]
  );
  const onSetSortMode = useCallback((mode: RootAccountSortMode) => {
    setSortMode(mode);
  }, []);
  const onRandomizeAccounts = useCallback(() => {
    setSortMode("random");
    setRandomSeed((current) => current + 1);
  }, []);
  const onSetMediaSort = useCallback((value: MediaSortMode) => {
    setMediaSort(value);
  }, []);
  const onRandomizeMedia = useCallback(() => {
    setMediaSort("random");
    setMediaRandomSeed((current) => current + 1);
  }, []);
  const onReachEnd = useCallback(() => {
    if (categoryHasMore && !categoryLoadingMore) {
      void loadMoreCategory();
    }
  }, [categoryHasMore, categoryLoadingMore, loadMoreCategory]);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFavoriteError(null);

    const preferredPath = categoryPath;
    resetRootPreviewQueue();

    try {
      const nextRoot = await loadRoot();
      if (!nextRoot) return;
      const refreshedAccounts = selectFilteredAccounts(rootStore.getState(), {
        search: deferredSearch,
        sortMode,
        mediaFilter,
        randomSeed,
      });
      enqueueRootPreviewPaths(refreshedAccounts.slice(0, 20).map((item) => item.path));
      await refreshCategory(
        {
          ...nextRoot,
          subfolders: refreshedAccounts,
          totals: {
            ...nextRoot.totals,
            subfolders: refreshedAccounts.length,
          },
        },
        preferredPath
      );
    } finally {
      setRefreshing(false);
    }
  }, [
    categoryPath,
    deferredSearch,
    enqueueRootPreviewPaths,
    loadRoot,
    mediaFilter,
    refreshCategory,
    refreshing,
    resetRootPreviewQueue,
    rootStore,
    randomSeed,
    sortMode,
  ]);
  const onReauthenticate = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/__tmv/login?returnTo=${encodeURIComponent(returnTo || "/")}`);
  }, []);
  const onOpenSystemUsage = useCallback(() => {
    setShowSystemUsage(true);
  }, []);
  const onCloseSystemUsage = useCallback(() => {
    setShowSystemUsage(false);
  }, []);
  const onRefreshSystemUsage = useCallback(() => {
    void systemUsageQuery.refetch();
  }, [systemUsageQuery]);
  const onToggleTheme = useCallback(() => {
    setManualTheme(true);
    setTheme(theme === "light" ? "dark" : "light");
  }, [setManualTheme, setTheme, theme]);
  const onToggleFavorite = useCallback(
    async (path: string, favorite: boolean) => {
      const previousFavorite =
        Boolean(selectCategorySummary(rootStore.getState(), path)?.favorite);
      rootStore.setFavorite(path, favorite);
      setFavoriteError(null);

      try {
        const saved = await postFolderFavorite({ path, favorite });
        rootStore.setFavorite(saved.path, saved.favorite);
      } catch (error) {
        rootStore.setFavorite(path, previousFavorite);
        setFavoriteError(error instanceof Error ? error.message : "收藏保存失败");
      }
    },
    [rootStore]
  );

  const scrollTrackingKey = `${categoryPreview?.folder.path ?? "-"}|${mediaFilter}|${mediaSort}|${sortMode}`;
  const {
    showScrollTop,
    heartCursorVisible,
    heartCursorRef,
    hoveredCardRef,
    onHeartHueChange,
    scrollToTop,
  } = useAppInteractions({
    selected,
    effectsEnabled,
    previewScrollRef,
    resetRootPreviewQueue,
    scrollTrackingKey,
  });
  const { onClose, onPrev, onNext, hasPrev, hasNext } = useModalNavigation({
    selected,
    media: categoryMedia,
    onSelect: setSelected,
  });

  const currentViewerPreferences = useMemo<ViewerPreferences>(
    () => ({
      search,
      sortMode,
      randomSeed,
      mediaSort,
      mediaRandomSeed,
      mediaFilter,
      categoryPath: categoryPath ?? undefined,
      theme,
      manualTheme,
      effectsMode,
      effectsRenderer,
    }),
    [
      categoryPath,
      effectsMode,
      effectsRenderer,
      manualTheme,
      mediaFilter,
      mediaRandomSeed,
      mediaSort,
      randomSeed,
      search,
      sortMode,
      theme,
    ]
  );

  useEffect(() => {
    if (persistedViewerPreferences) {
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
    }
  }, [persistedViewerPreferences]);

  useEffect(() => {
    if (
      !viewerPreferencesHydrated ||
      !themePreferencesHydrated ||
      !persistedViewerPreferences
    ) {
      return;
    }
    if (
      areViewerPreferencesEqual(
        lastSavedViewerPreferencesRef.current,
        currentViewerPreferences
      )
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      persistViewerPreferences(currentViewerPreferences);
    }, VIEWER_PREFERENCES_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    currentViewerPreferences,
    persistViewerPreferences,
    persistedViewerPreferences,
    themePreferencesHydrated,
    viewerPreferencesHydrated,
  ]);

  useEffect(() => {
    if (!viewerPreferencesHydrated || initialCategoryRestoreAttemptedRef.current) {
      return;
    }
    if (!filteredAccounts.length) {
      return;
    }
    initialCategoryRestoreAttemptedRef.current = true;
    if (
      preferredInitialCategoryPath &&
      filteredAccounts.some((item) => item.path === preferredInitialCategoryPath)
    ) {
      if (categoryPath !== preferredInitialCategoryPath) {
        void handleSelectCategory(preferredInitialCategoryPath);
      }
      return;
    }
    if (!categoryPath || !filteredAccounts.some((item) => item.path === categoryPath)) {
      void handleSelectCategory(filteredAccounts[0].path);
    }
  }, [
    categoryPath,
    filteredAccounts,
    handleSelectCategory,
    preferredInitialCategoryPath,
    viewerPreferencesHydrated,
  ]);

  useEffect(() => {
    if (viewerPreferencesHydrated && !initialCategoryRestoreAttemptedRef.current) {
      return;
    }
    if (rootVersion === 0) {
      return;
    }
    if (!filteredAccounts.length) {
      if (categoryPath) {
        resetCategory();
      }
      return;
    }
    if (!categoryPath) {
      void handleSelectCategory(filteredAccounts[0].path);
      return;
    }
    if (filteredAccounts.some((item) => item.path === categoryPath)) return;
    void handleSelectCategory(filteredAccounts[0].path);
  }, [
    categoryPath,
    filteredAccounts,
    handleSelectCategory,
    resetCategory,
    rootVersion,
    viewerPreferencesHydrated,
  ]);

  const requiresAuth = error === "Unauthorized" || categoryError === "Unauthorized";
  const preferenceError =
    viewerPreferencesQuery.error instanceof Error
      ? viewerPreferencesQuery.error.message
      : viewerPreferencesQuery.persistError instanceof Error
        ? viewerPreferencesQuery.persistError.message
        : null;
  const toolbarError = requiresAuth
    ? "认证已失效，正在跳转登录..."
    : error ?? favoriteError ?? preferenceError;

  useEffect(() => {
    if (!requiresAuth) {
      authRedirectedRef.current = false;
      return;
    }
    if (authRedirectedRef.current) return;
    authRedirectedRef.current = true;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`/__tmv/login?returnTo=${encodeURIComponent(returnTo || "/")}`);
  }, [requiresAuth]);

  useEffect(() => {
    if (!selected) return;
    if (!categoryPreview) {
      if (!categoryPath) {
        setSelected(null);
      }
      return;
    }

    const updated = categoryPreview.media.find((item) => item.path === selected.path);
    if (!updated) {
      setSelected(null);
      return;
    }

    if (
      updated.modified !== selected.modified ||
      updated.size !== selected.size ||
      updated.url !== selected.url ||
      updated.name !== selected.name
    ) {
      setSelected(updated);
    }
  }, [categoryPath, categoryPreview, selected]);

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
        setSortMode={onSetSortMode}
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
        accounts={filteredAccounts}
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
        filteredCategoryMediaCount={categoryMedia.length}
        categoryHasMore={categoryHasMore}
        categoryLoadingMore={categoryLoadingMore}
        hoveredCardRef={hoveredCardRef}
        onSelectMedia={setSelected}
        onReachEnd={onReachEnd}
        onVisibleCardsChange={onVisibleCardsChange}
      />

      <MediaPreviewModal
        media={selected}
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
