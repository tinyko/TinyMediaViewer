import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { postFolderFavorite } from "../../api";
import type { ViewerMediaSortMode, ViewerPreferences } from "../../types";
import { useCategoryMedia } from "../category/useCategoryMedia";
import { usePreviewBackfillQueue } from "../previews/usePreviewBackfillQueue";
import {
  areFolderPreviewArraysEqual,
  type RootAccountSortMode,
  selectCategorySummary,
  selectFilteredAccounts,
  useRootStoreSelector,
} from "../root/rootStore";
import { useRootFolder } from "../root/useRootFolder";
import { useSystemUsageReport } from "../systemUsage/useSystemUsageReport";

type MediaSortMode = ViewerMediaSortMode;
type ThemePreferences = Pick<
  ViewerPreferences,
  "theme" | "manualTheme" | "effectsMode" | "effectsRenderer"
>;

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

interface UseViewerSessionOptions {
  persistedViewerPreferences?: ViewerPreferences;
  preferencesReady: boolean;
  preferenceLoadError: unknown;
  persistViewerPreferences: (preferences: ViewerPreferences) => void;
  persistPreferenceError: unknown;
  themePreferences: ThemePreferences;
  themePreferencesReady: boolean;
}

export function useViewerSession({
  persistedViewerPreferences,
  preferencesReady,
  preferenceLoadError,
  persistViewerPreferences,
  persistPreferenceError,
  themePreferences,
  themePreferencesReady,
}: UseViewerSessionOptions) {
  const [viewerPreferencesHydrated, setViewerPreferencesHydrated] = useState(false);
  const [search, setSearch] = useState("");
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [sortMode, setSortMode] = useState<RootAccountSortMode>("time");
  const [randomSeed, setRandomSeed] = useState(0);
  const [mediaSort, setMediaSort] = useState<MediaSortMode>("desc");
  const [mediaRandomSeed, setMediaRandomSeed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [showSystemUsage, setShowSystemUsage] = useState(false);

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
    totalMediaCount,
    totalFilteredCount,
    categoryLoading,
    categoryLoadingMore,
    categoryHasMore,
    categoryError,
    handleSelectCategory,
    restoreCategory,
    refreshCategory,
    invalidateCategoryCache,
    loadMoreCategory,
    resetCategory,
  } = useCategoryMedia({
    rootVersion,
    mediaFilter,
    mediaSort,
    mediaRandomSeed,
  });
  const systemUsageQuery = useSystemUsageReport(showSystemUsage);
  const selectedCategorySummary = useRootStoreSelector(rootStore, (state) =>
    selectCategorySummary(state, categoryPath)
  );

  useEffect(() => {
    if (viewerPreferencesHydrated || !preferencesReady) {
      return;
    }

    if (persistedViewerPreferences) {
      setSearch(persistedViewerPreferences.search);
      setMediaFilter(persistedViewerPreferences.mediaFilter);
      setSortMode(persistedViewerPreferences.sortMode);
      setRandomSeed(persistedViewerPreferences.randomSeed);
      setMediaSort(persistedViewerPreferences.mediaSort);
      setMediaRandomSeed(persistedViewerPreferences.mediaRandomSeed);
      restoreCategory(persistedViewerPreferences.categoryPath ?? null);
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
    }

    setViewerPreferencesHydrated(true);
  }, [persistedViewerPreferences, preferencesReady, restoreCategory, viewerPreferencesHydrated]);

  useEffect(() => {
    if (persistedViewerPreferences) {
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
    }
  }, [persistedViewerPreferences]);

  const currentViewerPreferences = useMemo<ViewerPreferences>(
    () => ({
      search,
      sortMode,
      randomSeed,
      mediaSort,
      mediaRandomSeed,
      mediaFilter,
      categoryPath: categoryPath ?? undefined,
      ...themePreferences,
    }),
    [
      categoryPath,
      mediaFilter,
      mediaRandomSeed,
      mediaSort,
      randomSeed,
      search,
      sortMode,
      themePreferences,
    ]
  );

  useEffect(() => {
    if (
      !viewerPreferencesHydrated ||
      !preferencesReady ||
      !themePreferencesReady ||
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
    preferencesReady,
    themePreferencesReady,
    viewerPreferencesHydrated,
  ]);

  const preferredInitialCategoryPath =
    viewerPreferencesHydrated ? (persistedViewerPreferences?.categoryPath ?? null) : null;

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
    if (filteredAccounts.some((item) => item.path === categoryPath)) {
      return;
    }
    void handleSelectCategory(filteredAccounts[0].path);
  }, [
    categoryPath,
    filteredAccounts,
    handleSelectCategory,
    resetCategory,
    rootVersion,
    viewerPreferencesHydrated,
  ]);

  const onVisibleCategoryPathsChange = useCallback(
    (paths: string[]) => enqueueRootPreviewPaths(paths),
    [enqueueRootPreviewPaths]
  );

  const onSelectCategory = useCallback(
    (path: string) => {
      void handleSelectCategory(path);
    },
    [handleSelectCategory]
  );

  const onRandomizeAccounts = useCallback(() => {
    setSortMode("random");
    setRandomSeed((current) => current + 1);
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
    randomSeed,
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

  const onOpenSystemUsage = useCallback(() => {
    setShowSystemUsage(true);
  }, []);

  const onCloseSystemUsage = useCallback(() => {
    setShowSystemUsage(false);
  }, []);

  const onRefreshSystemUsage = useCallback(() => {
    systemUsageQuery.refresh();
  }, [systemUsageQuery]);

  const onToggleFavorite = useCallback(
    async (path: string, favorite: boolean) => {
      const previousFavorite =
        Boolean(selectCategorySummary(rootStore.getState(), path)?.favorite);
      rootStore.setFavorite(path, favorite);
      setFavoriteError(null);

      try {
        const saved = await postFolderFavorite({ path, favorite });
        rootStore.setFavorite(saved.path, saved.favorite);
      } catch (nextError) {
        rootStore.setFavorite(path, previousFavorite);
        setFavoriteError(nextError instanceof Error ? nextError.message : "收藏保存失败");
      }
    },
    [rootStore]
  );

  const selectedCounts = selectedCategorySummary?.countsReady ? selectedCategorySummary.counts : null;
  const totalMedia = selectedCounts
    ? selectedCounts.images + selectedCounts.gifs + selectedCounts.videos
    : totalMediaCount;
  const filteredCount = selectedCounts
    ? mediaFilter === "image"
      ? selectedCounts.images + selectedCounts.gifs
      : selectedCounts.videos
    : totalFilteredCount;
  const meterPercent = totalMedia ? Math.min(100, (filteredCount / totalMedia) * 100) : 0;

  const preferenceError =
    preferenceLoadError instanceof Error
      ? preferenceLoadError.message
      : persistPreferenceError instanceof Error
        ? persistPreferenceError.message
        : null;
  const requiresAuth = error === "Unauthorized" || categoryError === "Unauthorized";
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

  return {
    viewerPreferencesHydrated,
    rootStore,
    rootVersion,
    loading,
    deferredSearch,
    search,
    setSearch,
    mediaFilter,
    setMediaFilter,
    sortMode,
    setSortMode,
    randomSeed,
    mediaSort,
    setMediaSort,
    mediaRandomSeed,
    refreshing,
    filteredAccounts,
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
    invalidateCategoryCache,
    resetRootPreviewQueue,
  };
}
