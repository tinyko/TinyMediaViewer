import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import "./App.css";
import "./features/effects/effects.css";
import type { MediaItem } from "./types";
import { postFolderFavorite } from "./api";
import { MediaPreviewModal } from "./features/preview/MediaPreviewModal";
import { useModalNavigation } from "./features/preview/useModalNavigation";
import { ParticleField } from "./features/effects/ParticleField";
import { HeartPulseLayer } from "./features/effects/HeartPulseLayer";
import { useRootFolder } from "./features/root/useRootFolder";
import {
  areFolderPreviewArraysEqual,
  selectCategorySummary,
  selectFilteredAccounts,
  useRootStoreSelector,
} from "./features/root/rootStore";
import { usePreviewBackfillQueue } from "./features/previews/usePreviewBackfillQueue";
import { useCategoryMedia } from "./features/category/useCategoryMedia";
import { useThemeAndPerf } from "./features/ui/useThemeAndPerf";
import { useAppInteractions } from "./features/ui/useAppInteractions";
import { Toolbar } from "./components/Toolbar";
import { MainContent } from "./components/MainContent";

const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;

const APP_VERSION = import.meta.env.VITE_TMV_APP_VERSION ?? "0.1.0";
const APP_SHORT_COMMIT = import.meta.env.VITE_TMV_SHORT_COMMIT ?? "dev";
const APP_BUILD_TIME = import.meta.env.VITE_TMV_BUILD_TIME ?? "unknown";

function App() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [sortMode, setSortMode] = useState<"time" | "name" | "favorite">("time");
  const [mediaSort, setMediaSort] = useState<"asc" | "desc">("desc");
  const [refreshing, setRefreshing] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const authRedirectedRef = useRef(false);
  const deferredSearch = useDeferredValue(search);

  const { store: rootStore, loading, error, loadRoot } = useRootFolder();
  const rootVersion = useRootStoreSelector(rootStore, (state) => state.version);
  const filteredAccounts = useRootStoreSelector(
    rootStore,
    (state) =>
      selectFilteredAccounts(state, {
        search: deferredSearch,
        sortMode,
        mediaFilter,
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
    setCategoryVisibleCount,
    handleSelectCategory,
    refreshCategory,
    invalidateCategoryCache,
    loadMoreCategory,
    resetCategory,
  } = useCategoryMedia({ rootVersion, mediaFilter, mediaSort });
  const {
    theme,
    setTheme,
    setManualTheme,
    effectsMode,
    cycleEffectsMode,
    effectsRenderer,
    resolvedRenderer,
    toggleRenderer,
    effectsEnabled,
    perfNotice,
    reportVisibleCards,
  } = useThemeAndPerf();

  const versionLabel = `v${APP_VERSION}`;
  const versionFingerprint = `${versionLabel}+${APP_SHORT_COMMIT} (${APP_BUILD_TIME})`;
  const selectedCategorySummary = useRootStoreSelector(rootStore, (state) =>
    selectCategorySummary(state, categoryPath)
  );
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
  const onReachEnd = useCallback(() => {
    if (visibleMedia.length < categoryMedia.length) {
      startTransition(() => {
        setCategoryVisibleCount((previous) =>
          Math.min(previous + 32, categoryMedia.length)
        );
      });
      return;
    }
    if (categoryHasMore && !categoryLoadingMore) {
      void loadMoreCategory();
    }
  }, [
    categoryMedia.length,
    categoryHasMore,
    categoryLoadingMore,
    loadMoreCategory,
    setCategoryVisibleCount,
    visibleMedia.length,
  ]);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFavoriteError(null);

    const preferredPath = categoryPath;
    resetRootPreviewQueue();
    invalidateCategoryCache();

    try {
      const nextRoot = await loadRoot();
      if (!nextRoot) return;
      const refreshedAccounts = selectFilteredAccounts(rootStore.getState(), {
        search: deferredSearch,
        sortMode,
        mediaFilter,
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
        preferredPath,
        rootStore.getVersion()
      );
    } finally {
      setRefreshing(false);
    }
  }, [
    categoryPath,
    deferredSearch,
    enqueueRootPreviewPaths,
    invalidateCategoryCache,
    loadRoot,
    mediaFilter,
    refreshCategory,
    refreshing,
    resetRootPreviewQueue,
    rootStore,
    sortMode,
  ]);
  const onReauthenticate = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/__tmv/login?returnTo=${encodeURIComponent(returnTo || "/")}`);
  }, []);
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

  useEffect(() => {
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
  }, [categoryPath, filteredAccounts, handleSelectCategory, resetCategory]);

  const requiresAuth = error === "Unauthorized" || categoryError === "Unauthorized";
  const toolbarError = requiresAuth
    ? "认证已失效，正在跳转登录..."
    : error ?? favoriteError;

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
      <ParticleField enabled={effectsEnabled} cursorOffset={CURSOR_OFFSET} />
      <HeartPulseLayer
        enabled={effectsEnabled}
        hoveredCardRef={hoveredCardRef}
        onHueChange={onHeartHueChange}
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
        sortMode={sortMode}
        setSortMode={setSortMode}
        search={search}
        setSearch={setSearch}
        filteredCount={filteredCount}
        totalMedia={totalMedia}
        meterPercent={meterPercent}
        mediaSort={mediaSort}
        setMediaSort={setMediaSort}
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

      {showScrollTop && (
        <button className="scroll-top" onClick={scrollToTop} aria-label="回到顶部">
          ↑
        </button>
      )}
    </div>
  );
}

export default App;
