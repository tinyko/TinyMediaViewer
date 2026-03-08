import {
  useCallback,
  useMemo,
  useRef,
  useState,
  startTransition,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCategoryPage } from "../../api";
import type { RootSummaryPayload, MediaItem } from "../../types";
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
  const aggregateRef = useRef<{
    queryKey: string;
    pageSignatures: string[];
    media: MediaItem[];
  }>({
    queryKey: "",
    pageSignatures: [],
    media: [],
  });

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
      aggregateRef.current = {
        queryKey: queryKeyId,
        pageSignatures: [],
        media: [],
      };
      return [];
    }

    const pageSignatures = data.pages.map((page) => {
      const firstPath = page.media[0]?.path ?? "";
      const lastPath = page.media.at(-1)?.path ?? "";
      return `${page.nextCursor ?? ""}\u0000${page.media.length}\u0000${firstPath}\u0000${lastPath}`;
    });
    const previous = aggregateRef.current;
    const sameQuery = previous.queryKey === queryKeyId;
    const prefixMatches =
      sameQuery &&
      previous.pageSignatures.length <= pageSignatures.length &&
      previous.pageSignatures.every((signature, index) => signature === pageSignatures[index]);

    if (sameQuery && prefixMatches && previous.pageSignatures.length < pageSignatures.length) {
      let appended = previous.media;
      for (let index = previous.pageSignatures.length; index < data.pages.length; index += 1) {
        appended = mergeMediaByPath(appended, data.pages[index].media);
      }
      aggregateRef.current = {
        queryKey: queryKeyId,
        pageSignatures,
        media: appended,
      };
      return appended;
    }

    if (
      sameQuery &&
      previous.pageSignatures.length === pageSignatures.length &&
      previous.pageSignatures.every((signature, index) => signature === pageSignatures[index])
    ) {
      return previous.media;
    }

    const rebuilt = data.pages.reduce<MediaItem[]>(
      (merged, page) => mergeMediaByPath(merged, page.media),
      []
    );
    aggregateRef.current = {
      queryKey: queryKeyId,
      pageSignatures,
      media: rebuilt,
    };
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
    void queryClient.invalidateQueries({ queryKey: ["category"] });
  }, [queryClient]);

  const refreshCategory = useCallback(
    async (
      nextRootFolder: RootSummaryPayload | null,
      preferredPath: string | null
    ): Promise<void> => {
      invalidateCategoryCache();

      const nextPath =
        (preferredPath &&
          nextRootFolder?.subfolders.find((item) => item.path === preferredPath)?.path) ??
        nextRootFolder?.subfolders[0]?.path ??
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
