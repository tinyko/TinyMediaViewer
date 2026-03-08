import {
  useCallback,
  useMemo,
  useState,
  startTransition,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFolder } from "../../api";
import type { FolderPayload, MediaItem } from "../../types";
import { mergeMediaByPath, sortMediaByRandomSeed } from "./mediaUtils";

const SERVER_PAGE_SIZE = 120;

type CategoryMediaFilter = "image" | "video";
type MediaSortMode = "asc" | "desc" | "random";

interface UseCategoryMediaOptions {
  rootVersion: number;
  mediaFilter: CategoryMediaFilter;
  mediaSort: MediaSortMode;
  mediaRandomSeed: number;
}

export function useCategoryMedia({
  rootVersion,
  mediaFilter,
  mediaSort,
  mediaRandomSeed,
}: UseCategoryMediaOptions) {
  const queryClient = useQueryClient();
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const backendSort = mediaSort === "random" ? "desc" : mediaSort;

  const queryKey = useMemo(
    () => ["category", categoryPath, mediaFilter, backendSort, rootVersion],
    [backendSort, categoryPath, mediaFilter, rootVersion]
  );

  const {
    data,
    error,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const payload = await fetchFolder(categoryPath!, {
        cursor: pageParam,
        limit: SERVER_PAGE_SIZE,
        mode: "full",
        kind: mediaFilter,
        sort: backendSort,
        signal,
      });
      return payload;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    initialPageParam: undefined as string | undefined,
    enabled: !!categoryPath,
  });

  const categoryPreview = data?.pages[0]
    ? {
        ...data.pages[0],
        media: data.pages.flatMap((p) => p.media),
      }
    : null;

  const categoryMedia = useMemo(() => {
    if (!data) return [];
    let merged: MediaItem[] = [];
    for (const page of data.pages) {
      merged = mergeMediaByPath(merged, page.media);
    }
    return mediaSort === "random"
      ? sortMediaByRandomSeed(merged, mediaRandomSeed)
      : merged;
  }, [data, mediaRandomSeed, mediaSort]);

  const clearCategoryState = useCallback((nextPath: string | null = null) => {
    startTransition(() => {
      setCategoryPath(nextPath);
    });
  }, []);

  const handleSelectCategory = useCallback(async (path: string) => {
    startTransition(() => {
      setCategoryPath(path);
    });
  }, []);

  const restoreCategory = useCallback((path: string | null) => {
    setCategoryPath(path);
  }, []);

  const invalidateCategoryCache = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["category"] });
  }, [queryClient]);

  const refreshCategory = useCallback(
    async (
      nextRootFolder: FolderPayload | null,
      preferredPath: string | null
    ): Promise<FolderPayload | null> => {
      invalidateCategoryCache();

      const nextPath =
        (preferredPath &&
          nextRootFolder?.subfolders.find((item) => item.path === preferredPath)?.path) ??
        nextRootFolder?.subfolders[0]?.path ??
        null;

      if (!nextPath) {
        clearCategoryState();
        return null;
      }

      startTransition(() => {
        setCategoryPath(nextPath);
      });
      return null;
    },
    [clearCategoryState, invalidateCategoryCache]
  );

  const loadMoreCategory = useCallback(async () => {
    if (hasNextPage && !isFetchingNextPage) {
      await fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const resetCategory = useCallback(() => {
    invalidateCategoryCache();
    clearCategoryState();
  }, [clearCategoryState, invalidateCategoryCache]);

  const categoryErrorStr = error ? (error instanceof Error ? error.message : "加载失败") : null;

  return {
    categoryPath,
    categoryPreview,
    categoryMedia,
    visibleMedia: categoryMedia,
    totalFilteredCount: categoryMedia.length,
    categoryLoading: isLoading && !data,
    categoryLoadingMore: isFetchingNextPage,
    categoryHasMore: !!hasNextPage,
    categoryError: categoryErrorStr,
    handleSelectCategory,
    restoreCategory,
    refreshCategory,
    invalidateCategoryCache,
    loadMoreCategory,
    resetCategory,
  };
}
