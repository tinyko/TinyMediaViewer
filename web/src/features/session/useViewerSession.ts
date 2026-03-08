import {
  useCallback,
  useMemo,
  useState,
} from "react";
import type { ViewerMediaSortMode, ViewerPreferences } from "../../types";
import { useAuthRedirect } from "./useAuthRedirect";
import { useCategorySession } from "./useCategorySession";
import { useCategorySelectionCoordinator } from "./useCategorySelectionCoordinator";
import { useRefreshCoordinator } from "./useRefreshCoordinator";
import { useRootSession } from "./useRootSession";
import { useViewerPersistence } from "./useViewerPersistence";
import { useSystemUsageReport } from "../systemUsage/useSystemUsageReport";

type MediaSortMode = ViewerMediaSortMode;
type ThemePreferences = Pick<
  ViewerPreferences,
  "theme" | "manualTheme" | "effectsMode" | "effectsRenderer"
>;

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
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [mediaSort, setMediaSort] = useState<MediaSortMode>("desc");
  const [mediaRandomSeed, setMediaRandomSeed] = useState(0);
  const [showSystemUsage, setShowSystemUsage] = useState(false);
  const {
    search,
    setSearch,
    sortMode,
    setSortMode,
    randomSeed,
    setRandomSeed,
    deferredSearch,
    rootStore,
    rootVersion,
    loading,
    error,
    loadRoot,
    filteredAccountPaths,
    favoriteError,
    clearFavoriteError,
    onVisibleCategoryPathsChange,
    onRandomizeAccounts,
    onToggleFavorite,
    enqueueRootPreviewPaths,
    resetRootPreviewQueue,
  } = useRootSession({
    preferencesReady,
    mediaFilter,
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
    totalMedia,
    filteredCount,
    meterPercent,
    handleSelectCategory,
    onSelectCategory,
    restoreCategory,
    refreshCategory,
    invalidateCategoryCache,
    loadMoreCategory,
    resetCategory,
  } = useCategorySession({
    rootStore,
    rootVersion,
    mediaFilter,
    mediaSort,
    mediaRandomSeed,
  });
  const systemUsageQuery = useSystemUsageReport(showSystemUsage);

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

  const { viewerPreferencesHydrated, preferredInitialCategoryPath } = useViewerPersistence({
    persistedViewerPreferences,
    preferencesReady,
    themePreferencesReady,
    currentViewerPreferences,
    restoreCategory,
    persistViewerPreferences,
    setSearch,
    setMediaFilter,
    setSortMode,
    setRandomSeed,
    setMediaSort,
    setMediaRandomSeed,
  });

  useCategorySelectionCoordinator({
    viewerPreferencesHydrated,
    preferredInitialCategoryPath,
    categoryPath,
    filteredAccountPaths,
    handleSelectCategory,
    resetCategory,
    rootVersion,
  });

  const onRandomizeMedia = useCallback(() => {
    setMediaSort("random");
    setMediaRandomSeed((current) => current + 1);
  }, []);

  const onReachEnd = useCallback(() => {
    if (categoryHasMore && !categoryLoadingMore) {
      void loadMoreCategory();
    }
  }, [categoryHasMore, categoryLoadingMore, loadMoreCategory]);

  const { refreshing, onRefresh } = useRefreshCoordinator({
    categoryPath,
    rootStore,
    deferredSearch,
    mediaFilter,
    randomSeed,
    sortMode,
    loadRoot,
    clearFavoriteError,
    resetRootPreviewQueue,
    enqueueRootPreviewPaths,
    refreshCategory,
  });

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
  useAuthRedirect(requiresAuth);

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
    invalidateCategoryCache,
    resetRootPreviewQueue,
  };
}
