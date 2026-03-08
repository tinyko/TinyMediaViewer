import {
  useCallback,
  useMemo,
  useState,
  startTransition,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCategoryPage } from "../../api";
import type { MediaItem } from "../../types";
import { sortMediaByRandomSeed } from "./mediaUtils";

const SERVER_PAGE_SIZE = 120;
const CATEGORY_AGGREGATE_CACHE_LIMIT = 24;
const categoryAggregateCache = new Map<
  string,
  {
    pageSignatures: string[];
    media: MediaItem[];
    seenPaths: Set<string>;
  }
>();

const touchCategoryAggregateCache = (
  key: string,
  entry: {
    pageSignatures: string[];
    media: MediaItem[];
    seenPaths: Set<string>;
  }
) => {
  categoryAggregateCache.delete(key);
  categoryAggregateCache.set(key, entry);
  while (categoryAggregateCache.size > CATEGORY_AGGREGATE_CACHE_LIMIT) {
    const oldestKey = categoryAggregateCache.keys().next().value;
    if (!oldestKey) break;
    categoryAggregateCache.delete(oldestKey);
  }
};

const clearCategoryAggregateCache = () => {
  categoryAggregateCache.clear();
};

export const __categoryAggregateCacheForTests = {
  clear: clearCategoryAggregateCache,
  size: () => categoryAggregateCache.size,
  has: (key: string) => categoryAggregateCache.has(key),
};

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
  const queryKeyId = JSON.stringify(queryKey);

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
      const payload = await fetchCategoryPage(categoryPath!, {
        cursor: pageParam,
        limit: SERVER_PAGE_SIZE,
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

  const categoryPreview = data?.pages[0] ?? null;

  const categoryMediaBase = useMemo(() => {
    if (!data) {
      categoryAggregateCache.delete(queryKeyId);
      return [];
    }

    const pageSignatures = data.pages.map((page) => {
      const firstPath = page.media[0]?.path ?? "";
      const lastPath = page.media.at(-1)?.path ?? "";
      return `${page.nextCursor ?? ""}\u0000${page.media.length}\u0000${firstPath}\u0000${lastPath}`;
    });
    const previous = categoryAggregateCache.get(queryKeyId);
    const sameQuery = Boolean(previous);
    const prefixMatches =
      sameQuery &&
      previous!.pageSignatures.length <= pageSignatures.length &&
      previous!.pageSignatures.every((signature, index) => signature === pageSignatures[index]);

    if (sameQuery && prefixMatches && previous!.pageSignatures.length < pageSignatures.length) {
      const appended = previous!.media.slice();
      const seenPaths = previous!.seenPaths;
      for (let index = previous!.pageSignatures.length; index < data.pages.length; index += 1) {
        for (const item of data.pages[index].media) {
          if (seenPaths.has(item.path)) continue;
          seenPaths.add(item.path);
          appended.push(item);
        }
      }
      touchCategoryAggregateCache(queryKeyId, {
        pageSignatures,
        media: appended,
        seenPaths,
      });
      return appended;
    }

    if (
      sameQuery &&
      previous!.pageSignatures.length === pageSignatures.length &&
      previous!.pageSignatures.every((signature, index) => signature === pageSignatures[index])
    ) {
      touchCategoryAggregateCache(queryKeyId, previous!);
      return previous!.media;
    }

    const rebuilt: MediaItem[] = [];
    const seenPaths = new Set<string>();
    for (const page of data.pages) {
      for (const item of page.media) {
        if (seenPaths.has(item.path)) continue;
        seenPaths.add(item.path);
        rebuilt.push(item);
      }
    }
    touchCategoryAggregateCache(queryKeyId, {
      pageSignatures,
      media: rebuilt,
      seenPaths,
    });
    return rebuilt;
  }, [data, queryKeyId]);

  const categoryMedia = useMemo(
    () =>
      mediaSort === "random"
        ? sortMediaByRandomSeed(categoryMediaBase, mediaRandomSeed)
        : categoryMediaBase,
    [categoryMediaBase, mediaRandomSeed, mediaSort]
  );

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
    clearCategoryAggregateCache();
    void queryClient.invalidateQueries({ queryKey: ["category"] });
  }, [queryClient]);

  const refreshCategory = useCallback(
    async (candidatePaths: readonly string[], preferredPath: string | null): Promise<void> => {
      invalidateCategoryCache();

      const nextPath =
        (preferredPath && candidatePaths.includes(preferredPath) ? preferredPath : null) ??
        candidatePaths[0] ??
        null;

      if (!nextPath) {
        clearCategoryState();
        return;
      }

      startTransition(() => {
        setCategoryPath(nextPath);
      });
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
    categoryCounts: categoryPreview?.counts ?? null,
    totalMediaCount: categoryPreview?.totalMedia ?? 0,
    totalFilteredCount: categoryPreview?.filteredTotal ?? categoryMediaBase.length,
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
