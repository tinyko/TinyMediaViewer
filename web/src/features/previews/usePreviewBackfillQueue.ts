import { useCallback, useEffect, useRef } from "react";
import { fetchFolderPreviews, postPreviewDiagnostics } from "../../api";
import type { PreviewDiagEvent } from "../../types";
import type { RootFolderStore } from "../root/rootStore";

const ROOT_PREVIEW_BATCH_SIZE = 20;
const ROOT_PREVIEW_MAX_CONCURRENCY = 4;
const ROOT_PREVIEW_RETRY_LIMIT = 2;
const ROOT_PREVIEW_TIMEOUT_MS = 12_000;
const PREVIEW_DIAG_RING_LIMIT = 200;
const PREVIEW_DIAG_FLUSH_MS = 300;

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const parseStatusCode = (error: unknown): number | undefined => {
  if (!(error instanceof Error)) return undefined;
  const match = /\((\d{3})\)/.exec(error.message);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

interface UsePreviewBackfillQueueOptions {
  rootStore: RootFolderStore;
}

export function usePreviewBackfillQueue({
  rootStore,
}: UsePreviewBackfillQueueOptions) {
  const rootPreviewSeq = useRef(0);
  const rootPreviewPending = useRef<string[]>([]);
  const rootPreviewPendingSet = useRef(new Set<string>());
  const rootPreviewInFlight = useRef(new Set<string>());
  const rootPreviewForceSingle = useRef(new Set<string>());
  const rootPreviewRetry = useRef(new Map<string, number>());
  const rootPreviewRunning = useRef(0);
  const rootPreviewControllers = useRef(new Set<AbortController>());
  const pumpRootPreviewQueueRef = useRef<() => void>(() => undefined);
  const previewDiagRing = useRef<PreviewDiagEvent[]>([]);
  const previewDiagPending = useRef<PreviewDiagEvent[]>([]);
  const previewDiagFlushTimer = useRef<number | null>(null);

  const flushPreviewDiagnostics = useCallback(async () => {
    if (!previewDiagPending.current.length) return;
    const payload = previewDiagPending.current.splice(0, previewDiagPending.current.length);
    await postPreviewDiagnostics({ events: payload });
  }, []);

  const schedulePreviewDiagnosticsFlush = useCallback(() => {
    if (previewDiagFlushTimer.current !== null) return;
    previewDiagFlushTimer.current = window.setTimeout(() => {
      previewDiagFlushTimer.current = null;
      void flushPreviewDiagnostics();
    }, PREVIEW_DIAG_FLUSH_MS);
  }, [flushPreviewDiagnostics]);

  const pushPreviewDiagEvent = useCallback(
    (event: Omit<PreviewDiagEvent, "ts"> & { ts?: number }) => {
      const payload: PreviewDiagEvent = {
        ...event,
        ts: event.ts ?? Date.now(),
        paths: event.paths.map((path) => path.trim()).filter(Boolean),
      };
      previewDiagRing.current.push(payload);
      if (previewDiagRing.current.length > PREVIEW_DIAG_RING_LIMIT) {
        previewDiagRing.current.splice(
          0,
          previewDiagRing.current.length - PREVIEW_DIAG_RING_LIMIT
        );
      }
      previewDiagPending.current.push(payload);
      schedulePreviewDiagnosticsFlush();
    },
    [schedulePreviewDiagnosticsFlush]
  );

  const resetRootPreviewQueue = useCallback(() => {
    rootPreviewSeq.current += 1;
    rootPreviewPending.current = [];
    rootPreviewPendingSet.current.clear();
    rootPreviewInFlight.current.clear();
    rootPreviewForceSingle.current.clear();
    rootPreviewRetry.current.clear();
    rootPreviewRunning.current = 0;
    for (const controller of rootPreviewControllers.current) {
      controller.abort();
    }
    rootPreviewControllers.current.clear();
  }, []);

  const requeueFailedPreviewPaths = useCallback(
    (
      paths: string[],
      options?: { forceSingle?: boolean; expectedVersion?: number }
    ) => {
      if (!paths.length) return;
      const exhausted: string[] = [];

      for (const rawPath of paths) {
        const failedPath = rawPath.trim();
        if (!failedPath) continue;

        if (options?.forceSingle) {
          rootPreviewForceSingle.current.add(failedPath);
        }

        const retry = rootPreviewRetry.current.get(failedPath) ?? 0;
        if (retry >= ROOT_PREVIEW_RETRY_LIMIT) {
          exhausted.push(failedPath);
          rootPreviewRetry.current.delete(failedPath);
          rootPreviewForceSingle.current.delete(failedPath);
          continue;
        }

        rootPreviewRetry.current.set(failedPath, retry + 1);
        if (
          !rootPreviewPendingSet.current.has(failedPath) &&
          !rootPreviewInFlight.current.has(failedPath)
        ) {
          rootPreviewPending.current.push(failedPath);
          rootPreviewPendingSet.current.add(failedPath);
        }
      }

      rootStore.markPreviewFailed(exhausted, {
        expectedVersion: options?.expectedVersion,
      });
    },
    [rootStore]
  );

  const pumpRootPreviewQueue = useCallback(() => {
    const seq = rootPreviewSeq.current;
    while (
      rootPreviewRunning.current < ROOT_PREVIEW_MAX_CONCURRENCY &&
      rootPreviewPending.current.length
    ) {
      const batch: string[] = [];
      let forceSingleBatch = false;

      while (rootPreviewPending.current.length && batch.length < ROOT_PREVIEW_BATCH_SIZE) {
        const next = rootPreviewPending.current.shift();
        if (!next) break;
        rootPreviewPendingSet.current.delete(next);
        if (rootPreviewInFlight.current.has(next)) continue;

        const requiresSingle = rootPreviewForceSingle.current.has(next);
        if (!batch.length) {
          batch.push(next);
          rootPreviewInFlight.current.add(next);
          forceSingleBatch = requiresSingle;
          if (requiresSingle) break;
          continue;
        }

        if (forceSingleBatch || requiresSingle) {
          if (!rootPreviewPendingSet.current.has(next)) {
            rootPreviewPending.current.unshift(next);
            rootPreviewPendingSet.current.add(next);
          }
          break;
        }

        batch.push(next);
        rootPreviewInFlight.current.add(next);
      }

      if (!batch.length) break;

      rootPreviewRunning.current += 1;
      const rootVersion = rootStore.getVersion();
      const requestId = `rp-${seq}-${rootVersion}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      pushPreviewDiagEvent({
        phase: "enqueue",
        batchSize: batch.length,
        paths: batch,
        requestId,
      });
      pushPreviewDiagEvent({
        phase: "request",
        batchSize: batch.length,
        paths: batch,
        requestId,
      });

      const controller = new AbortController();
      rootPreviewControllers.current.add(controller);
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ROOT_PREVIEW_TIMEOUT_MS);

      void fetchFolderPreviews(
        {
          paths: batch,
          limitPerFolder: 6,
        },
        {
          signal: controller.signal,
        }
      )
        .then((result) => {
          if (seq !== rootPreviewSeq.current) return;
          pushPreviewDiagEvent({
            phase: "response",
            batchSize: result.items.length,
            paths: batch,
            status: 200,
            requestId,
          });

          rootStore.applyPreviewBatch(result.items, {
            expectedVersion: rootVersion,
          });
          if (result.items.length) {
            pushPreviewDiagEvent({
              phase: "apply",
              batchSize: result.items.length,
              paths: result.items.map((item) => item.path),
              status: 200,
              requestId,
            });
          }

          const successPaths = new Set(result.items.map((item) => item.path));
          for (const successPath of successPaths) {
            rootPreviewRetry.current.delete(successPath);
            rootPreviewForceSingle.current.delete(successPath);
          }

          const failedByServer = (result.errors ?? []).map((item) => item.path);
          const failed = new Set(failedByServer);
          for (const path of batch) {
            if (!successPaths.has(path) && !failed.has(path)) {
              failed.add(path);
            }
          }

          if (failed.size) {
            pushPreviewDiagEvent({
              phase: "error",
              batchSize: failed.size,
              paths: [...failed],
              status: 200,
              err: `Preview batch partially failed (${failed.size}/${batch.length})`,
              requestId,
            });
            requeueFailedPreviewPaths([...failed], {
              forceSingle: batch.length > 1,
              expectedVersion: rootVersion,
            });
          }
        })
        .catch((error) => {
          if ((isAbortError(error) && !timedOut) || seq !== rootPreviewSeq.current) return;

          const err =
            error instanceof Error
              ? error.message
              : timedOut
                ? "Preview request timeout"
                : "Unknown preview error";
          pushPreviewDiagEvent({
            phase: timedOut ? "timeout" : "error",
            batchSize: batch.length,
            paths: batch,
            status: parseStatusCode(error),
            err,
            requestId,
          });
          requeueFailedPreviewPaths(batch, {
            forceSingle: batch.length > 1,
            expectedVersion: rootVersion,
          });
        })
        .finally(() => {
          window.clearTimeout(timeoutId);
          rootPreviewControllers.current.delete(controller);
          for (const finishedPath of batch) {
            rootPreviewInFlight.current.delete(finishedPath);
          }
          rootPreviewRunning.current = Math.max(0, rootPreviewRunning.current - 1);
          if (seq === rootPreviewSeq.current) {
            queueMicrotask(() => pumpRootPreviewQueueRef.current());
          }
        });
    }
  }, [pushPreviewDiagEvent, requeueFailedPreviewPaths, rootStore]);

  useEffect(() => {
    pumpRootPreviewQueueRef.current = pumpRootPreviewQueue;
  }, [pumpRootPreviewQueue]);

  const enqueueRootPreviewPaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      for (const input of paths) {
        const candidate = input.trim();
        if (!candidate || rootStore.hasCountsReady(candidate)) continue;
        if (
          rootPreviewPendingSet.current.has(candidate) ||
          rootPreviewInFlight.current.has(candidate)
        ) {
          continue;
        }
        rootPreviewPending.current.push(candidate);
        rootPreviewPendingSet.current.add(candidate);
      }
      pumpRootPreviewQueue();
    },
    [pumpRootPreviewQueue, rootStore]
  );

  useEffect(() => {
    return () => {
      if (previewDiagFlushTimer.current !== null) {
        window.clearTimeout(previewDiagFlushTimer.current);
        previewDiagFlushTimer.current = null;
      }
      void flushPreviewDiagnostics();
      resetRootPreviewQueue();
    };
  }, [flushPreviewDiagnostics, resetRootPreviewQueue]);

  return {
    enqueueRootPreviewPaths,
    resetRootPreviewQueue,
  };
}
