import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFolder } from "../../api";
import type { FolderPayload } from "../../types";
import { createRootFolderStore } from "./rootStore";

const SERVER_PAGE_SIZE = 240;

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

interface UseRootFolderOptions {
  onBeforeLoad?: () => void;
  onUnmount?: () => void;
}

export function useRootFolder(options: UseRootFolderOptions = {}) {
  const { onBeforeLoad, onUnmount } = options;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const store = useMemo(() => createRootFolderStore(), []);

  const abortRef = useRef<AbortController | null>(null);
  const requestSeq = useRef(0);

  const loadRoot = useCallback(async (): Promise<FolderPayload | null> => {
    abortRef.current?.abort();
    onBeforeLoad?.();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestSeq.current;

    setLoading(true);
    setError(null);

    try {
      const payload = await fetchFolder("", {
        limit: SERVER_PAGE_SIZE,
        mode: "light",
        signal: controller.signal,
      });
      if (requestId !== requestSeq.current) return null;
      store.replaceRoot(payload);
      return payload;
    } catch (err) {
      if (isAbortError(err)) return null;
      const message = err instanceof Error ? err.message : "加载失败";
      setError(message);
      return null;
    } finally {
      if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [onBeforeLoad, store]);

  useEffect(() => {
    void loadRoot();
    return () => {
      abortRef.current?.abort();
      onUnmount?.();
    };
  }, [loadRoot, onUnmount]);

  return {
    store,
    loading,
    error,
    loadRoot,
  };
}
