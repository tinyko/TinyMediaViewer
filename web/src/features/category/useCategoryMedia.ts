/* eslint-disable react-hooks/refs */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  startTransition,
} from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchCategoryPage } from "../../api";
import type { MediaItem } from "../../types";
import { sortMediaByRandomSeed } from "./mediaUtils";

const SERVER_PAGE_SIZE = 120;

type CategoryMediaFilter = "image" | "video";
type MediaSortMode = "asc" | "desc" | "random";
type BackendSortMode = "asc" | "desc";

interface UseCategoryMediaOptions {
  rootVersion: number;
  mediaFilter: CategoryMediaFilter;
  mediaSort: MediaSortMode;
  mediaRandomSeed: number;
}

interface CategoryAggregateState {
  categoryPath: string | null;
  mediaFilter: CategoryMediaFilter;
  backendSort: BackendSortMode;
  rootVersion: number;
  pageSignatures: string[];
  media: MediaItem[];
  seenPaths: Set<string>;
}

const isSameAggregateKey = (
  aggregate: CategoryAggregateState | null,
  key: Pick<
    CategoryAggregateState,
    "categoryPath" | "mediaFilter" | "backendSort" | "rootVersion"
  >
) =>
  Boolean(aggregate) &&
  aggregate!.categoryPath === key.categoryPath &&
  aggregate!.mediaFilter === key.mediaFilter &&
  aggregate!.backendSort === key.backendSort &&
  aggregate!.rootVersion === key.rootVersion;

const buildPageSignatures = (
  pages: readonly {
    media: MediaItem[];
    nextCursor?: string | null;
  }[]
) =>
  pages.map((page) => {
    const firstPath = page.media[0]?.path ?? "";
    const lastPath = page.media.at(-1)?.path ?? "";
    return `${page.nextCursor ?? ""}\u0000${page.media.length}\u0000${firstPath}\u0000${lastPath}`;
  });

const rebuildAggregateMedia = (
  pages: readonly {
    media: MediaItem[];
  }[]
) => {
  const media: MediaItem[] = [];
  const seenPaths = new Set<string>();
  for (const page of pages) {
    for (const item of page.media) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      media.push(item);
    }
  }
  return { media, seenPaths };
};

export function useCategoryMedia({
  rootVersion,
  mediaFilter,
  mediaSort,
  mediaRandomSeed,
}: UseCategoryMediaOptions) {
  const aggregateRef = useRef<CategoryAggregateState | null>(null);
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const backendSort: BackendSortMode = mediaSort === "random" ? "desc" : mediaSort;

  const queryKey = useMemo(
    () => ["category", categoryPath, mediaFilter, backendSort, rootVersion] as const,
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
    const aggregateKey = {
      categoryPath,
      mediaFilter,
      backendSort,
      rootVersion,
    };

    if (!data) {
      return [];
    }

    const pageSignatures = buildPageSignatures(data.pages);
    const previous = aggregateRef.current;
    const sameKey = isSameAggregateKey(previous, aggregateKey);
    const prefixMatches =
      sameKey &&
      previous!.pageSignatures.length <= pageSignatures.length &&
      previous!.pageSignatures.every((signature, index) => signature === pageSignatures[index]);

    if (sameKey && prefixMatches && previous!.pageSignatures.length < pageSignatures.length) {
      const appended = previous!.media.slice();
      const seenPaths = new Set(previous!.seenPaths);
      for (let index = previous!.pageSignatures.length; index < data.pages.length; index += 1) {
        for (const item of data.pages[index].media) {
          if (seenPaths.has(item.path)) continue;
          seenPaths.add(item.path);
          appended.push(item);
        }
      }
      aggregateRef.current = {
        ...aggregateKey,
        pageSignatures,
        media: appended,
        seenPaths,
      };
      return appended;
    }

    if (
      sameKey &&
      previous!.pageSignatures.length === pageSignatures.length &&
      previous!.pageSignatures.every((signature, index) => signature === pageSignatures[index])
    ) {
      return previous!.media;
    }

    const rebuilt = rebuildAggregateMedia(data.pages);
    aggregateRef.current = {
      ...aggregateKey,
      pageSignatures,
      media: rebuilt.media,
      seenPaths: rebuilt.seenPaths,
    };
    return rebuilt.media;
  }, [backendSort, categoryPath, data, mediaFilter, rootVersion]);

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

  const refreshCategory = useCallback(
    async (candidatePaths: readonly string[], preferredPath: string | null): Promise<void> => {
      const nextPath =
        (preferredPath && candidatePaths.includes(preferredPath) ? preferredPath : null) ??
        candidatePaths[0] ??
        null;

      if (!nextPath) {
        clearCategoryState();
        return;
      }

      if (nextPath !== categoryPath) {
        startTransition(() => {
          setCategoryPath(nextPath);
        });
      }
    },
    [categoryPath, clearCategoryState]
  );

  const loadMoreCategory = useCallback(async () => {
    if (hasNextPage && !isFetchingNextPage) {
      await fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const resetCategory = useCallback(() => {
    clearCategoryState();
  }, [clearCategoryState]);

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
    loadMoreCategory,
    resetCategory,
  };
}
