import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { fetchFolder } from "../../api";
import type { FolderPayload } from "../../types";
import { mergeMediaByPath } from "./mediaUtils";

const SERVER_PAGE_SIZE = 120;
const INITIAL_VISIBLE_ITEMS = 48;
const PAGE_STEP = 32;

type CategoryCacheEntry = {
  payload: FolderPayload;
  nextCursor?: string;
};

type CategoryMediaFilter = "image" | "video";

interface SelectCategoryOptions {
  forceReload?: boolean;
}

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

interface UseCategoryMediaOptions {
  rootFolder: FolderPayload | null;
  mediaFilter: CategoryMediaFilter;
}

const makeCategoryCacheKey = (path: string, mediaFilter: CategoryMediaFilter) =>
  `${mediaFilter}:${path}`;

export function useCategoryMedia({ rootFolder, mediaFilter }: UseCategoryMediaOptions) {
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
  const previousMediaFilterRef = useRef<CategoryMediaFilter>(mediaFilter);

  const clearCategoryState = useCallback((nextPath: string | null = null) => {
    setCategoryPath(nextPath);
    setCategoryPreview(null);
    setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
    setCategoryLoading(false);
    setCategoryLoadingMore(false);
    setCategoryHasMore(false);
    setCategoryError(null);
  }, []);

  const invalidateCategoryCache = useCallback(() => {
    categoryAbortRef.current?.abort();
    categoryLoadMoreAbortRef.current?.abort();
    categoryLoadMoreAbortRef.current = null;
    categoryRequestSeq.current += 1;
    categoryLoadMoreSeq.current += 1;
    previewCache.current.clear();
    setCategoryLoading(false);
    setCategoryLoadingMore(false);
  }, []);

  const loadCategory = useCallback(
    async (
      path: string,
      options: SelectCategoryOptions = {}
    ): Promise<FolderPayload | null> => {
      const { forceReload = false } = options;
      const cacheKey = makeCategoryCacheKey(path, mediaFilter);

      setCategoryPath(path);
      setCategoryLoading(true);
      setCategoryError(null);
      setCategoryHasMore(false);
      setCategoryLoadingMore(false);
      categoryLoadMoreSeq.current += 1;

      const requestId = ++categoryRequestSeq.current;
      categoryAbortRef.current?.abort();
      const controller = new AbortController();
      categoryAbortRef.current = controller;

      try {
        const cached = forceReload ? undefined : previewCache.current.get(cacheKey);
        if (cached) {
          if (requestId !== categoryRequestSeq.current) return null;
          startTransition(() => {
            setCategoryPreview(cached.payload);
            setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
            setCategoryHasMore(Boolean(cached.nextCursor));
          });
          return cached.payload;
        }

        const payload = await fetchFolder(path, {
          limit: SERVER_PAGE_SIZE,
          mode: "full",
          kind: mediaFilter,
          signal: controller.signal,
        });
        if (requestId !== categoryRequestSeq.current) return null;

        const entry: CategoryCacheEntry = {
          payload: { ...payload, media: [...payload.media] },
          nextCursor: payload.nextCursor,
        };
        previewCache.current.set(cacheKey, entry);
        startTransition(() => {
          setCategoryPreview(entry.payload);
          setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
          setCategoryHasMore(Boolean(entry.nextCursor));
        });
        return entry.payload;
      } catch (err) {
        if (isAbortError(err)) return null;
        const message = err instanceof Error ? err.message : "加载失败";
        setCategoryError(message);
        setCategoryPreview(null);
        setCategoryHasMore(false);
        return null;
      } finally {
        if (requestId === categoryRequestSeq.current) {
          setCategoryLoading(false);
        }
      }
    },
    [mediaFilter]
  );

  const resetCategory = useCallback(() => {
    invalidateCategoryCache();
    clearCategoryState();
  }, [clearCategoryState, invalidateCategoryCache]);

  const handleSelectCategory = useCallback(async (path: string) => {
    await loadCategory(path);
  }, [loadCategory]);

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

      setCategoryPath(nextPath);
      return loadCategory(nextPath, { forceReload: true });
    },
    [clearCategoryState, invalidateCategoryCache, loadCategory]
  );

  const loadMoreCategory = useCallback(async () => {
    if (!categoryPath || categoryLoadingMore || !categoryHasMore) return;
    const cacheKey = makeCategoryCacheKey(categoryPath, mediaFilter);
    const cached = previewCache.current.get(cacheKey);
    if (!cached?.nextCursor) {
      setCategoryHasMore(false);
      return;
    }

    const expectedCursor = cached.nextCursor;
    const requestId = ++categoryLoadMoreSeq.current;
    categoryLoadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    categoryLoadMoreAbortRef.current = controller;
    setCategoryError(null);
    setCategoryLoadingMore(true);

    try {
      const payload = await fetchFolder(categoryPath, {
        cursor: expectedCursor,
        limit: SERVER_PAGE_SIZE,
        mode: "full",
        kind: mediaFilter,
        signal: controller.signal,
      });
      if (requestId !== categoryLoadMoreSeq.current) return;

      const latest = previewCache.current.get(cacheKey);
      if (!latest || latest.nextCursor !== expectedCursor) return;

      const mergedPayload: FolderPayload = {
        ...latest.payload,
        folder: payload.folder,
        breadcrumb: payload.breadcrumb,
        subfolders: payload.subfolders,
        totals: payload.totals,
        media: mergeMediaByPath(latest.payload.media, payload.media),
      };

      previewCache.current.set(cacheKey, {
        payload: mergedPayload,
        nextCursor: payload.nextCursor,
      });

      startTransition(() => {
        setCategoryPreview(mergedPayload);
        setCategoryHasMore(Boolean(payload.nextCursor));
      });
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
    } finally {
      if (categoryLoadMoreAbortRef.current === controller) {
        categoryLoadMoreAbortRef.current = null;
      }
      if (requestId === categoryLoadMoreSeq.current) {
        setCategoryLoadingMore(false);
      }
    }
  }, [categoryHasMore, categoryLoadingMore, categoryPath, mediaFilter]);

  const revealMoreLocal = useCallback(() => {
    setCategoryVisibleCount((previous) => previous + PAGE_STEP);
  }, []);

  useEffect(() => {
    if (!rootFolder) {
      resetCategory();
      return;
    }

    if (!rootFolder.subfolders.length) {
      resetCategory();
      return;
    }

    if (!categoryPath) {
      void handleSelectCategory(rootFolder.subfolders[0].path);
      return;
    }

    const exists = rootFolder.subfolders.some((item) => item.path === categoryPath);
    if (!exists) {
      void handleSelectCategory(rootFolder.subfolders[0].path);
    }
  }, [categoryPath, handleSelectCategory, resetCategory, rootFolder]);

  useEffect(() => {
    if (previousMediaFilterRef.current === mediaFilter) return;
    previousMediaFilterRef.current = mediaFilter;
    if (!categoryPath) return;
    void loadCategory(categoryPath);
  }, [categoryPath, loadCategory, mediaFilter]);

  useEffect(() => {
    return () => {
      categoryAbortRef.current?.abort();
      categoryLoadMoreAbortRef.current?.abort();
    };
  }, []);

  return {
    categoryPath,
    categoryPreview,
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
