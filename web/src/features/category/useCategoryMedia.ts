import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchFolder } from "../../api";
import type { FolderPayload, MediaItem } from "../../types";
import { mergeMediaByPath } from "./mediaUtils";

const SERVER_PAGE_SIZE = 120;
const INITIAL_VISIBLE_ITEMS = 48;
const PAGE_STEP = 32;
const EMPTY_MEDIA: MediaItem[] = [];

type CategoryMediaFilter = "image" | "video";
type MediaSortDirection = "asc" | "desc";

type CategoryCacheEntry = {
  payload: FolderPayload;
  media: MediaItem[];
  nextCursor?: string;
};

interface SelectCategoryOptions {
  forceReload?: boolean;
  expectedRootVersion?: number;
}

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

interface UseCategoryMediaOptions {
  rootVersion: number;
  mediaFilter: CategoryMediaFilter;
  mediaSort: MediaSortDirection;
}

const makeCategoryCacheKey = (
  path: string,
  mediaFilter: CategoryMediaFilter,
  mediaSort: MediaSortDirection
) => `${mediaFilter}:${mediaSort}:${path}`;

export function useCategoryMedia({
  rootVersion,
  mediaFilter,
  mediaSort,
}: UseCategoryMediaOptions) {
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const [categoryPreview, setCategoryPreview] = useState<FolderPayload | null>(null);
  const [categoryVisibleCount, setCategoryVisibleCount] = useState(INITIAL_VISIBLE_ITEMS);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryLoadingMore, setCategoryLoadingMore] = useState(false);
  const [categoryHasMore, setCategoryHasMore] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const previewCache = useRef(new Map<string, CategoryCacheEntry>());
  const categoryAbortRef = useRef<AbortController | null>(null);
  const categoryLoadMoreAbortRef = useRef<AbortController | null>(null);
  const categoryRequestSeq = useRef(0);
  const categoryLoadMoreSeq = useRef(0);
  const previousQueryKeyRef = useRef(`${mediaFilter}:${mediaSort}`);
  const rootVersionRef = useRef(rootVersion);

  useEffect(() => {
    rootVersionRef.current = rootVersion;
  }, [rootVersion]);

  const clearCategoryState = useCallback((nextPath: string | null = null) => {
    startTransition(() => {
      setCategoryPath(nextPath);
      setCategoryPreview(null);
      setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
      setCategoryLoading(false);
      setCategoryLoadingMore(false);
      setCategoryHasMore(false);
      setCategoryError(null);
    });
  }, []);

  const invalidateCategoryCache = useCallback(() => {
    categoryAbortRef.current?.abort();
    categoryLoadMoreAbortRef.current?.abort();
    categoryLoadMoreAbortRef.current = null;
    categoryRequestSeq.current += 1;
    categoryLoadMoreSeq.current += 1;
    previewCache.current.clear();
    startTransition(() => {
      setCategoryLoading(false);
      setCategoryLoadingMore(false);
    });
  }, []);

  const loadCategory = useCallback(
    async (
      path: string,
      options: SelectCategoryOptions = {}
    ): Promise<FolderPayload | null> => {
      const {
        forceReload = false,
        expectedRootVersion = rootVersionRef.current,
      } = options;
      const cacheKey = makeCategoryCacheKey(path, mediaFilter, mediaSort);

      startTransition(() => {
        setCategoryPath(path);
        setCategoryLoading(true);
        setCategoryError(null);
        setCategoryHasMore(false);
        setCategoryLoadingMore(false);
        setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
      });
      categoryLoadMoreSeq.current += 1;

      const requestId = ++categoryRequestSeq.current;
      categoryAbortRef.current?.abort();
      const controller = new AbortController();
      categoryAbortRef.current = controller;

      try {
        const cached = forceReload ? undefined : previewCache.current.get(cacheKey);
        if (cached) {
          if (
            requestId !== categoryRequestSeq.current ||
            expectedRootVersion !== rootVersionRef.current
          ) {
            return null;
          }
          startTransition(() => {
            setCategoryPreview(cached.payload);
            setCategoryHasMore(Boolean(cached.nextCursor));
          });
          return cached.payload;
        }

        const payload = await fetchFolder(path, {
          limit: SERVER_PAGE_SIZE,
          mode: "full",
          kind: mediaFilter,
          sort: mediaSort,
          signal: controller.signal,
        });
        if (
          requestId !== categoryRequestSeq.current ||
          expectedRootVersion !== rootVersionRef.current
        ) {
          return null;
        }

        const entry: CategoryCacheEntry = {
          payload: { ...payload, media: payload.media.slice() },
          media: payload.media.slice(),
          nextCursor: payload.nextCursor,
        };
        previewCache.current.set(cacheKey, entry);
        startTransition(() => {
          setCategoryPreview(entry.payload);
          setCategoryHasMore(Boolean(entry.nextCursor));
        });
        return entry.payload;
      } catch (err) {
        if (isAbortError(err)) return null;
        const message = err instanceof Error ? err.message : "加载失败";
        startTransition(() => {
          setCategoryError(message);
          setCategoryPreview(null);
          setCategoryHasMore(false);
        });
        return null;
      } finally {
        if (requestId === categoryRequestSeq.current) {
          startTransition(() => {
            setCategoryLoading(false);
          });
        }
      }
    },
    [mediaFilter, mediaSort]
  );

  const resetCategory = useCallback(() => {
    invalidateCategoryCache();
    clearCategoryState();
  }, [clearCategoryState, invalidateCategoryCache]);

  const handleSelectCategory = useCallback(
    async (path: string) => {
      await loadCategory(path);
    },
    [loadCategory]
  );

  const refreshCategory = useCallback(
    async (
      nextRootFolder: FolderPayload | null,
      preferredPath: string | null,
      expectedRootVersion = rootVersionRef.current
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

      return loadCategory(nextPath, {
        forceReload: true,
        expectedRootVersion,
      });
    },
    [clearCategoryState, invalidateCategoryCache, loadCategory]
  );

  const loadMoreCategory = useCallback(async () => {
    if (!categoryPath || categoryLoadingMore || !categoryHasMore) return;
    const cacheKey = makeCategoryCacheKey(categoryPath, mediaFilter, mediaSort);
    const cached = previewCache.current.get(cacheKey);
    if (!cached?.nextCursor) {
      startTransition(() => {
        setCategoryHasMore(false);
      });
      return;
    }

    const expectedCursor = cached.nextCursor;
    const expectedRootVersion = rootVersionRef.current;
    const requestId = ++categoryLoadMoreSeq.current;
    categoryLoadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    categoryLoadMoreAbortRef.current = controller;
    startTransition(() => {
      setCategoryError(null);
      setCategoryLoadingMore(true);
    });

    try {
      const payload = await fetchFolder(categoryPath, {
        cursor: expectedCursor,
        limit: SERVER_PAGE_SIZE,
        mode: "full",
        kind: mediaFilter,
        sort: mediaSort,
        signal: controller.signal,
      });
      if (
        requestId !== categoryLoadMoreSeq.current ||
        expectedRootVersion !== rootVersionRef.current
      ) {
        return;
      }

      const latest = previewCache.current.get(cacheKey);
      if (!latest || latest.nextCursor !== expectedCursor) return;

      const media = mergeMediaByPath(latest.media, payload.media);
      const mergedPayload: FolderPayload = {
        ...latest.payload,
        folder: payload.folder,
        breadcrumb: payload.breadcrumb,
        subfolders: payload.subfolders,
        totals: payload.totals,
        media,
      };

      previewCache.current.set(cacheKey, {
        payload: mergedPayload,
        media,
        nextCursor: payload.nextCursor,
      });

      startTransition(() => {
        setCategoryPreview(mergedPayload);
        setCategoryHasMore(Boolean(payload.nextCursor));
      });
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : "加载失败";
      startTransition(() => {
        setCategoryError(message);
      });
    } finally {
      if (categoryLoadMoreAbortRef.current === controller) {
        categoryLoadMoreAbortRef.current = null;
      }
      if (requestId === categoryLoadMoreSeq.current) {
        startTransition(() => {
          setCategoryLoadingMore(false);
        });
      }
    }
  }, [categoryHasMore, categoryLoadingMore, categoryPath, mediaFilter, mediaSort]);

  const revealMoreLocal = useCallback(() => {
    startTransition(() => {
      setCategoryVisibleCount((previous) => previous + PAGE_STEP);
    });
  }, []);

  const currentCacheKey = categoryPath
    ? makeCategoryCacheKey(categoryPath, mediaFilter, mediaSort)
    : null;
  const categoryMedia = useMemo(() => {
    if (!currentCacheKey || !categoryPreview) return EMPTY_MEDIA;
    return previewCache.current.get(currentCacheKey)?.media ?? EMPTY_MEDIA;
  }, [categoryPreview, currentCacheKey]);
  const visibleMedia = useMemo(
    () => categoryMedia.slice(0, categoryVisibleCount),
    [categoryMedia, categoryVisibleCount]
  );

  useEffect(() => {
    const nextQueryKey = `${mediaFilter}:${mediaSort}`;
    if (previousQueryKeyRef.current === nextQueryKey) return;
    previousQueryKeyRef.current = nextQueryKey;
    if (!categoryPath) return;
    void loadCategory(categoryPath);
  }, [categoryPath, loadCategory, mediaFilter, mediaSort]);

  return {
    categoryPath,
    categoryPreview,
    categoryMedia,
    visibleMedia,
    totalFilteredCount: categoryMedia.length,
    categoryVisibleCount,
    categoryLoading,
    categoryLoadingMore,
    categoryHasMore,
    categoryError,
    setCategoryVisibleCount,
    revealMoreLocal,
    handleSelectCategory,
    refreshCategory,
    invalidateCategoryCache,
    loadMoreCategory,
    resetCategory,
  };
}
