import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFolder } from "../../api";
import type { FolderPayload } from "../../types";
import { mergeMediaByPath } from "./mediaUtils";

const SERVER_PAGE_SIZE = 240;
const INITIAL_VISIBLE_ITEMS = 48;
const PAGE_STEP = 32;

type CategoryCacheEntry = {
  payload: FolderPayload;
  nextCursor?: string;
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

interface UseCategoryMediaOptions {
  rootFolder: FolderPayload | null;
}

export function useCategoryMedia({ rootFolder }: UseCategoryMediaOptions) {
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  const [categoryPreview, setCategoryPreview] = useState<FolderPayload | null>(null);
  const [categoryVisibleCount, setCategoryVisibleCount] = useState(INITIAL_VISIBLE_ITEMS);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryLoadingMore, setCategoryLoadingMore] = useState(false);
  const [categoryHasMore, setCategoryHasMore] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const previewCache = useRef(new Map<string, CategoryCacheEntry>());
  const categoryAbortRef = useRef<AbortController | null>(null);
  const categoryRequestSeq = useRef(0);
  const categoryLoadMoreSeq = useRef(0);

  const resetCategory = useCallback(() => {
    categoryAbortRef.current?.abort();
    categoryLoadMoreSeq.current += 1;
    setCategoryPath(null);
    setCategoryPreview(null);
    setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
    setCategoryLoading(false);
    setCategoryLoadingMore(false);
    setCategoryHasMore(false);
    setCategoryError(null);
    previewCache.current.clear();
  }, []);

  const handleSelectCategory = useCallback(async (path: string) => {
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
      const cached = previewCache.current.get(path);
      if (cached) {
        if (requestId !== categoryRequestSeq.current) return;
        setCategoryPreview(cached.payload);
        setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
        setCategoryHasMore(Boolean(cached.nextCursor));
        return;
      }

      const payload = await fetchFolder(path, {
        limit: SERVER_PAGE_SIZE,
        mode: "full",
        signal: controller.signal,
      });
      if (requestId !== categoryRequestSeq.current) return;

      const entry: CategoryCacheEntry = {
        payload: { ...payload, media: [...payload.media] },
        nextCursor: payload.nextCursor,
      };
      previewCache.current.set(path, entry);
      setCategoryPreview(entry.payload);
      setCategoryVisibleCount(INITIAL_VISIBLE_ITEMS);
      setCategoryHasMore(Boolean(entry.nextCursor));
    } catch (err) {
      if (isAbortError(err)) return;
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
      setCategoryPreview(null);
      setCategoryHasMore(false);
    } finally {
      if (requestId === categoryRequestSeq.current) {
        setCategoryLoading(false);
      }
    }
  }, []);

  const loadMoreCategory = useCallback(async () => {
    if (!categoryPath || categoryLoadingMore || !categoryHasMore) return;
    const cached = previewCache.current.get(categoryPath);
    if (!cached?.nextCursor) {
      setCategoryHasMore(false);
      return;
    }

    const expectedCursor = cached.nextCursor;
    const requestId = ++categoryLoadMoreSeq.current;
    setCategoryLoadingMore(true);
    setCategoryError(null);

    try {
      const payload = await fetchFolder(categoryPath, {
        cursor: expectedCursor,
        limit: SERVER_PAGE_SIZE,
        mode: "full",
      });
      if (requestId !== categoryLoadMoreSeq.current) return;

      const latest = previewCache.current.get(categoryPath);
      if (!latest || latest.nextCursor !== expectedCursor) return;

      const mergedPayload: FolderPayload = {
        ...latest.payload,
        folder: payload.folder,
        breadcrumb: payload.breadcrumb,
        subfolders: payload.subfolders,
        totals: payload.totals,
        media: mergeMediaByPath(latest.payload.media, payload.media),
      };

      previewCache.current.set(categoryPath, {
        payload: mergedPayload,
        nextCursor: payload.nextCursor,
      });

      setCategoryPreview(mergedPayload);
      setCategoryHasMore(Boolean(payload.nextCursor));
    } catch (err) {
      const message = err instanceof Error ? err.message : "加载失败";
      setCategoryError(message);
    } finally {
      if (requestId === categoryLoadMoreSeq.current) {
        setCategoryLoadingMore(false);
      }
    }
  }, [categoryHasMore, categoryLoadingMore, categoryPath]);

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
    return () => {
      categoryAbortRef.current?.abort();
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
    loadMoreCategory,
    resetCategory,
  };
}

