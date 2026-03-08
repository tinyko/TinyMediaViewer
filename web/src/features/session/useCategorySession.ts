import { useCallback } from "react";
import { selectCategorySummary, useRootStoreSelector, type RootFolderStore } from "../root/rootStore";
import { useCategoryMedia } from "../category/useCategoryMedia";

type MediaSortMode = "asc" | "desc" | "random";

interface UseCategorySessionOptions {
  rootStore: RootFolderStore;
  rootVersion: number;
  mediaFilter: "image" | "video";
  mediaSort: MediaSortMode;
  mediaRandomSeed: number;
}

export function useCategorySession({
  rootStore,
  rootVersion,
  mediaFilter,
  mediaSort,
  mediaRandomSeed,
}: UseCategorySessionOptions) {
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
  const selectedCategorySummary = useRootStoreSelector(rootStore, (state) =>
    selectCategorySummary(state, categoryPath)
  );

  const onSelectCategory = useCallback(
    (path: string) => {
      void handleSelectCategory(path);
    },
    [handleSelectCategory]
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

  return {
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
  };
}
