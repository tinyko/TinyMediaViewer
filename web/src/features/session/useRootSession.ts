import { useCallback, useDeferredValue, useState } from "react";
import { postFolderFavorite } from "../../api";
import {
  areStringArraysEqual,
  type RootAccountSortMode,
  selectCategorySummary,
  selectFilteredAccountPaths,
  useRootStoreSelector,
} from "../root/rootStore";
import { useRootFolder } from "../root/useRootFolder";
import { usePreviewBackfillQueue } from "../previews/usePreviewBackfillQueue";

interface UseRootSessionOptions {
  preferencesReady: boolean;
  mediaFilter: "image" | "video";
}

export function useRootSession({
  preferencesReady,
  mediaFilter,
}: UseRootSessionOptions) {
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<RootAccountSortMode>("time");
  const [randomSeed, setRandomSeed] = useState(0);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  const { store: rootStore, loading, error, loadRoot } = useRootFolder({
    enabled: preferencesReady,
  });
  const rootVersion = useRootStoreSelector(rootStore, (state) => state.version);
  const filteredAccountPaths = useRootStoreSelector(
    rootStore,
    (state) =>
      selectFilteredAccountPaths(state, {
        search: deferredSearch,
        sortMode,
        mediaFilter,
        randomSeed,
      }),
    areStringArraysEqual
  );
  const { enqueueRootPreviewPaths, resetRootPreviewQueue } = usePreviewBackfillQueue({
    rootStore,
  });

  const onVisibleCategoryPathsChange = useCallback(
    (paths: string[]) => enqueueRootPreviewPaths(paths),
    [enqueueRootPreviewPaths]
  );

  const onRandomizeAccounts = useCallback(() => {
    setSortMode("random");
    setRandomSeed((current) => current + 1);
  }, []);

  const clearFavoriteError = useCallback(() => {
    setFavoriteError(null);
  }, []);

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

  return {
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
  };
}
