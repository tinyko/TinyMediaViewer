import { useCallback, useState } from "react";
import { selectFilteredAccountPaths, type RootFolderStore } from "../root/rootStore";
import type { ViewerAccountSortMode } from "../../types";

interface UseRefreshCoordinatorOptions {
  categoryPath: string | null;
  rootStore: RootFolderStore;
  deferredSearch: string;
  sortMode: ViewerAccountSortMode;
  mediaFilter: "image" | "video";
  randomSeed: number;
  loadRoot: () => Promise<unknown>;
  clearFavoriteError: () => void;
  resetRootPreviewQueue: () => void;
  enqueueRootPreviewPaths: (paths: string[]) => void;
  refreshCategory: (
    candidatePaths: readonly string[],
    preferredPath: string | null
  ) => Promise<void>;
}

export function useRefreshCoordinator({
  categoryPath,
  rootStore,
  deferredSearch,
  sortMode,
  mediaFilter,
  randomSeed,
  loadRoot,
  clearFavoriteError,
  resetRootPreviewQueue,
  enqueueRootPreviewPaths,
  refreshCategory,
}: UseRefreshCoordinatorOptions) {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    clearFavoriteError();

    const preferredPath = categoryPath;
    resetRootPreviewQueue();

    try {
      const didLoad = await loadRoot();
      if (!didLoad) return;

      const refreshedAccountPaths = selectFilteredAccountPaths(rootStore.getState(), {
        search: deferredSearch,
        sortMode,
        mediaFilter,
        randomSeed,
      });
      enqueueRootPreviewPaths(refreshedAccountPaths.slice(0, 20));
      await refreshCategory(refreshedAccountPaths, preferredPath);
    } finally {
      setRefreshing(false);
    }
  }, [
    categoryPath,
    clearFavoriteError,
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

  return {
    refreshing,
    onRefresh,
  };
}
