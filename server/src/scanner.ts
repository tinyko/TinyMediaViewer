import { createHash } from "crypto";
import fs from "fs/promises";
import { Dirent, FSWatcher, Stats, watch as watchFs } from "fs";
import path from "path";
import type {
  FolderPayload,
  FolderPreview,
  FolderPreviewBatchError,
  MediaItem,
  MediaKind,
} from "@tmv/shared-types";
import { IndexStore } from "./index_store";

export type {
  FolderPayload,
  FolderPreview,
  FolderPreviewBatchError,
  MediaItem,
  MediaKind,
} from "@tmv/shared-types";

export type FolderMode = "light" | "full";
export type FolderMediaFilter = "image" | "video";

export interface FolderPreviewBatchResult {
  items: FolderPreview[];
  errors: FolderPreviewBatchError[];
  slowestPath?: string;
  slowestMs: number;
}

export interface FolderSnapshot {
  folder: {
    name: string;
    path: string;
  };
  breadcrumb: { name: string; path: string }[];
  subfolders: FolderPreview[];
  media: MediaItem[];
  totals: { media: number; subfolders: number };
}

interface CacheEntry {
  stamp: string;
  createdAt: number;
  snapshot: FolderSnapshot;
  approxBytes: number;
}

interface PreviewCacheEntry {
  generation: number;
  createdAt: number;
  preview: FolderPreview;
  approxBytes: number;
}

interface DirectoryManifest {
  generation: number;
  rootModified: number;
  media: MediaItem[];
  subfolders: FolderEntryCandidate[];
  subfolderCount: number;
  watchedDirectories: FolderEntryCandidate[];
}

type PersistedDirectoryManifest = Omit<DirectoryManifest, "generation">;

interface FolderEntryCandidate {
  name: string;
  absolutePath: string;
  relativePath: string;
  modified?: number;
}

interface MediaCandidate extends FolderEntryCandidate {
  kind: MediaKind;
}

interface FolderScanResult {
  subfolders: FolderEntryCandidate[];
  subfolderCount: number;
  mediaCandidates: MediaCandidate[];
  watchedDirectories: FolderEntryCandidate[];
}

interface PendingManifestRefresh {
  rootRelativePath: string;
  requiresRebuild: boolean;
  changes: { watchedRelativePath: string; filename: string }[];
}

interface ResolvedPath {
  safeRelativePath: string;
  absolutePath: string;
}

const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]);
const videoExts = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"]);
const IMAGE_THUMBNAIL_MIN_BYTES = 512 * 1024;
const toPosix = (value: string) => value.replace(/\\/g, "/");

const encodePath = (value: string) =>
  value
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

const detectMediaKind = (ext: string): MediaKind | null => {
  if (ext === ".gif") return "gif";
  if (imageExts.has(ext)) return "image";
  if (videoExts.has(ext)) return "video";
  return null;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const estimateStringBytes = (value: string) => Buffer.byteLength(value, "utf8") + 2;

const estimateNumberBytes = (value: number) =>
  Number.isFinite(value) ? String(value).length : 4;

const estimateMediaItemBytes = (item: MediaItem) =>
  96 +
  estimateStringBytes(item.name) +
  estimateStringBytes(item.path) +
  estimateStringBytes(item.url) +
  (item.thumbnailUrl ? estimateStringBytes(item.thumbnailUrl) + 16 : 0) +
  estimateStringBytes(item.kind) +
  estimateNumberBytes(item.size) +
  estimateNumberBytes(item.modified);

const estimateFolderPreviewBytes = (preview: FolderPreview) =>
  160 +
  estimateStringBytes(preview.name) +
  estimateStringBytes(preview.path) +
  estimateNumberBytes(preview.modified) +
  estimateNumberBytes(preview.counts.images) +
  estimateNumberBytes(preview.counts.gifs) +
  estimateNumberBytes(preview.counts.videos) +
  estimateNumberBytes(preview.counts.subfolders) +
  preview.previews.reduce((sum, item) => sum + estimateMediaItemBytes(item), 0);

const parseCursor = (cursor?: string) => {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new Error("Invalid cursor");
  }
  return Number(cursor);
};

const matchesMediaFilter = (
  item: MediaItem,
  filter?: FolderMediaFilter
) => {
  if (!filter) return true;
  if (filter === "video") {
    return item.kind === "video";
  }
  return item.kind === "image" || item.kind === "gif";
};

const pageMediaForFilter = (
  media: MediaItem[],
  cursor: number,
  limit: number,
  filter?: FolderMediaFilter
) => {
  if (!filter) {
    if (cursor > media.length) {
      throw new Error("Cursor exceeds media item count");
    }
    const items = media.slice(cursor, cursor + limit);
    const nextIndex = cursor + items.length;
    return {
      items,
      nextCursor: nextIndex < media.length ? String(nextIndex) : undefined,
    };
  }

  const items: MediaItem[] = [];
  let matchedCount = 0;
  let hasMore = false;

  for (const item of media) {
    if (!matchesMediaFilter(item, filter)) continue;

    if (matchedCount < cursor) {
      matchedCount += 1;
      continue;
    }

    if (items.length < limit) {
      items.push(item);
      matchedCount += 1;
      continue;
    }

    hasMore = true;
    break;
  }

  if (cursor > matchedCount) {
    throw new Error("Cursor exceeds media item count");
  }

  return {
    items,
    nextCursor: hasMore ? String(cursor + items.length) : undefined,
  };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) => {
  if (!items.length) return [] as R[];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
};

export class MediaScanner {
  private static readonly CACHE_VERSION = "v5";
  private static readonly INDEX_VERSION = 5;

  private readonly root: string;
  private readonly rootRealPathPromise: Promise<string>;
  private readonly indexStore?: IndexStore;
  private snapshotCache = new Map<string, CacheEntry>();
  private snapshotCacheTotalBytes = 0;
  private previewCache = new Map<string, PreviewCacheEntry>();
  private previewCacheTotalBytes = 0;
  private manifestCache = new Map<string, DirectoryManifest & { createdAt: number; approxBytes: number }>();
  private manifestCacheTotalBytes = 0;
  private manifestOwnersByWatchedPath = new Map<string, Set<string>>();
  private pendingManifestRefreshes = new Map<string, PendingManifestRefresh>();
  private inFlightManifestMutations = new Map<string, Promise<void>>();
  private inFlightManifestValidations = new Map<string, Promise<void>>();
  private inFlightScans = new Map<string, Promise<FolderSnapshot>>();
  private inFlightPreviews = new Map<string, Promise<FolderPreview>>();
  private inFlightManifests = new Map<string, Promise<DirectoryManifest>>();
  private watchedDirs = new Map<string, FSWatcher>();
  private pathGenerations = new Map<string, number>();
  private readonly categoryDirs = new Set([
    "image",
    "images",
    "video",
    "videos",
    "gif",
    "gifs",
    "media",
    "medias",
  ]);

  constructor(
    root: string,
    private readonly previewLimit: number,
    private readonly maxItems: number,
    private readonly defaultPageLimit: number,
    private readonly maxPageLimit: number,
    private readonly statConcurrency: number,
    private readonly cacheTtlMs: number,
    private readonly cacheMaxEntries: number,
    private readonly cacheMaxBytes: number,
    enableIndexPersist: boolean,
    indexDir: string,
    indexMaxBytes: number
  ) {
    this.root = path.resolve(root);
    this.rootRealPathPromise = fs.realpath(this.root);
    if (enableIndexPersist) {
      this.indexStore = new IndexStore({
        dir: indexDir,
        maxBytes: indexMaxBytes,
        version: MediaScanner.INDEX_VERSION,
      });
    }
  }

  async getFolder(
    relativePath = "",
    options: {
      cursor?: string;
      limit?: number;
      mode?: FolderMode;
      mediaFilter?: FolderMediaFilter;
    } = {}
  ): Promise<FolderPayload> {
    const mode = options.mode ?? "full";
    const snapshot =
      mode === "light"
        ? await this.getLightFolderSnapshot(relativePath)
        : await this.getFullFolderSnapshot(relativePath);

    const cursor = parseCursor(options.cursor);
    const limitInput =
      typeof options.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : this.defaultPageLimit;
    const limit = clamp(Math.floor(limitInput), 1, this.maxPageLimit);
    const { items: pageMedia, nextCursor } = pageMediaForFilter(
      snapshot.media,
      cursor,
      limit,
      options.mediaFilter
    );

    return {
      folder: snapshot.folder,
      breadcrumb: snapshot.breadcrumb,
      subfolders: snapshot.subfolders,
      media: pageMedia,
      totals: snapshot.totals,
      nextCursor,
    };
  }

  async getFolderPreviews(
    paths: string[],
    limitPerFolder?: number
  ): Promise<FolderPreviewBatchResult> {
    const uniquePaths = Array.from(
      new Set(
        paths
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => toPosix(value))
      )
    );
    const normalizedLimit = clamp(
      Math.floor(limitPerFolder ?? this.previewLimit),
      1,
      Math.max(this.previewLimit * 4, this.previewLimit)
    );

    const results = await mapWithConcurrency(
      uniquePaths,
      clamp(Math.floor(this.statConcurrency / 2), 2, 8),
      async (relativePath) => {
        const startedAt = Date.now();
        try {
          const preview = await this.getFolderPreview(relativePath, normalizedLimit);
          return {
            path: relativePath,
            elapsedMs: Date.now() - startedAt,
            preview,
            error: undefined,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to build folder preview";
          return {
            path: relativePath,
            elapsedMs: Date.now() - startedAt,
            preview: undefined,
            error: message,
          };
        }
      }
    );

    const items: FolderPreview[] = [];
    const errors: FolderPreviewBatchError[] = [];
    let slowestPath: string | undefined;
    let slowestMs = 0;

    for (const result of results) {
      if (result.elapsedMs > slowestMs) {
        slowestMs = result.elapsedMs;
        slowestPath = result.path;
      }

      if (result.preview) {
        items.push(result.preview);
      } else if (result.error) {
        errors.push({
          path: result.path,
          error: result.error,
        });
      }
    }

    return {
      items,
      errors,
      slowestPath,
      slowestMs,
    };
  }

  async resolveMediaFile(relativePath: string) {
    const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
    if (!safeRelativePath) {
      throw new Error("Missing media file path");
    }
    const ext = path.extname(absolutePath).toLowerCase();
    const kind = detectMediaKind(ext);
    if (!kind) {
      throw new Error("Unsupported media extension");
    }
    return { safeRelativePath, absolutePath, kind };
  }

  close() {
    for (const watcher of this.watchedDirs.values()) {
      watcher.close();
    }
    this.watchedDirs.clear();
    this.snapshotCache.clear();
    this.previewCache.clear();
    this.manifestCache.clear();
    this.manifestOwnersByWatchedPath.clear();
    this.pendingManifestRefreshes.clear();
    this.inFlightManifestMutations.clear();
    this.inFlightManifestValidations.clear();
    this.pathGenerations.clear();
    this.snapshotCacheTotalBytes = 0;
    this.previewCacheTotalBytes = 0;
    this.manifestCacheTotalBytes = 0;
    this.inFlightManifests.clear();
  }

  private async getFullFolderSnapshot(relativePath: string): Promise<FolderSnapshot> {
    const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const cacheKey = this.snapshotKey("full", safeRelativePath);
    const generationStamp = this.snapshotStampForGeneration(safeRelativePath);
    const cached = this.readSnapshotCache(cacheKey, generationStamp);
    if (cached) return cached;

    const running = this.inFlightScans.get(cacheKey);
    if (running) return running;

    const task = this.buildFullFolderSnapshot(absolutePath, safeRelativePath)
      .then((snapshot) => {
        this.writeSnapshotCache(cacheKey, generationStamp, snapshot);
        return snapshot;
      })
      .finally(() => {
        this.inFlightScans.delete(cacheKey);
      });

    this.inFlightScans.set(cacheKey, task);
    return task;
  }

  private async getLightFolderSnapshot(relativePath: string): Promise<FolderSnapshot> {
    const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const cacheKey = this.snapshotKey("light", safeRelativePath);
    const cached = this.readSnapshotCache(
      cacheKey,
      this.snapshotStampForMtime(stat.mtimeMs)
    );
    if (cached) return cached;

    const running = this.inFlightScans.get(cacheKey);
    if (running) return running;

    const indexStamp = await this.buildLightIndexStamp(
      absolutePath,
      safeRelativePath,
      stat
    );
    const indexed = await this.readFromIndex<FolderSnapshot>(cacheKey, indexStamp);
    if (indexed) {
      this.writeSnapshotCache(
        cacheKey,
        this.snapshotStampForMtime(stat.mtimeMs),
        indexed
      );
      return indexed;
    }

    const runningAfterIndexRead = this.inFlightScans.get(cacheKey);
    if (runningAfterIndexRead) return runningAfterIndexRead;

    const task = this.buildLightFolderSnapshot(absolutePath, safeRelativePath)
      .then((snapshot) => {
        this.writeSnapshotCache(
          cacheKey,
          this.snapshotStampForMtime(stat.mtimeMs),
          snapshot
        );
        void this.writeToIndex(cacheKey, indexStamp, snapshot);
        return snapshot;
      })
      .finally(() => {
        this.inFlightScans.delete(cacheKey);
      });

    this.inFlightScans.set(cacheKey, task);
    return task;
  }

  private async getFolderPreview(
    relativePath: string,
    previewLimitOverride: number
  ): Promise<FolderPreview> {
    const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
    return this.getResolvedFolderPreview(
      absolutePath,
      safeRelativePath,
      previewLimitOverride
    );
  }

  private async getResolvedFolderPreview(
    absolutePath: string,
    safeRelativePath: string,
    previewLimitOverride: number
  ): Promise<FolderPreview> {
    const inFlightKey = `${safeRelativePath}::${previewLimitOverride}`;
    const running = this.inFlightPreviews.get(inFlightKey);
    if (running) return running;

    const task = (async () => {
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        throw new Error("Requested path is not a directory");
      }
      const indexKey = this.previewKey(safeRelativePath, previewLimitOverride);
      const generation = this.getPathGeneration(safeRelativePath);
      const cached = this.readPreviewCache(indexKey, generation);
      if (cached) {
        return cached;
      }
      const manifest = this.readManifestCache(this.manifestKey(safeRelativePath), generation);
      const indexStamp = manifest
        ? this.buildPreviewIndexStampFromManifest(safeRelativePath, stat.mtimeMs, manifest)
        : await this.buildPreviewIndexStamp(absolutePath, safeRelativePath, stat);
      const indexed = await this.readFromIndex<FolderPreview>(indexKey, indexStamp);
      if (indexed) {
        this.writePreviewCache(indexKey, generation, indexed);
        return indexed;
      }

      const preview = await this.buildFolderPreview(
        absolutePath,
        safeRelativePath,
        previewLimitOverride
      );
      this.writePreviewCache(indexKey, generation, preview);
      void this.writeToIndex(indexKey, indexStamp, preview);
      return preview;
    })().finally(() => {
      this.inFlightPreviews.delete(inFlightKey);
    });

    this.inFlightPreviews.set(inFlightKey, task);
    return task;
  }

  private async readFromIndex<T>(cacheKey: string, stamp: string) {
    if (!this.indexStore) return null;
    try {
      return await this.indexStore.readSnapshot<T>(cacheKey, stamp);
    } catch {
      return null;
    }
  }

  private async writeToIndex<T>(cacheKey: string, stamp: string, snapshot: T) {
    if (!this.indexStore) return;
    try {
      await this.indexStore.writeSnapshot(cacheKey, stamp, snapshot);
    } catch {
      // Index persistence failure should not break runtime scans.
    }
  }

  private snapshotKey(mode: FolderMode, safeRelativePath: string) {
    return `${MediaScanner.CACHE_VERSION}:${mode}:${safeRelativePath}`;
  }

  private previewKey(safeRelativePath: string, previewLimitOverride: number) {
    return `${MediaScanner.CACHE_VERSION}:preview:${safeRelativePath}:${previewLimitOverride}`;
  }

  private manifestKey(safeRelativePath: string) {
    return `${MediaScanner.CACHE_VERSION}:manifest:${safeRelativePath}`;
  }

  private async getDirectoryManifest(
    absolutePath: string,
    safeRelativePath: string,
    options: {
      allowFastRestore?: boolean;
    } = {}
  ): Promise<DirectoryManifest> {
    const cacheKey = this.manifestKey(safeRelativePath);
    const generation = this.getPathGeneration(safeRelativePath);
    const cached = this.readManifestCache(cacheKey, generation);
    if (cached) return cached;

    const running = this.inFlightManifests.get(cacheKey);
    if (running) return running;

    const task = (async () => {
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        throw new Error("Requested path is not a directory");
      }

      const restored = await this.restorePersistedDirectoryManifest(
        cacheKey,
        absolutePath,
        safeRelativePath,
        stat,
        generation,
        options.allowFastRestore ?? false
      );
      if (restored) {
        this.installManifestWatches(absolutePath, safeRelativePath, restored.manifest);
        this.writeManifestCache(cacheKey, restored.manifest);
        if (restored.revalidateInBackground) {
          this.schedulePersistedManifestValidation(
            cacheKey,
            absolutePath,
            safeRelativePath,
            stat,
            generation,
            restored.persisted
          );
        } else if (restored.shouldPersist) {
          void this.writeToIndex(
            cacheKey,
            this.buildManifestIndexStampFromManifest(restored.manifest),
            this.persistDirectoryManifest(restored.manifest)
          );
        }
        return restored.manifest;
      }

      const manifest = await this.buildDirectoryManifest(
        absolutePath,
        safeRelativePath,
        generation,
        stat.mtimeMs
      );
      this.installManifestWatches(absolutePath, safeRelativePath, manifest);
      this.writeManifestCache(cacheKey, manifest);
      void this.writeToIndex(
        cacheKey,
        this.buildManifestIndexStampFromManifest(manifest),
        this.persistDirectoryManifest(manifest)
      );
      return manifest;
    })().finally(() => {
      this.inFlightManifests.delete(cacheKey);
    });

    this.inFlightManifests.set(cacheKey, task);
    return task;
  }

  private async buildDirectoryManifest(
    absolutePath: string,
    safeRelativePath: string,
    generation: number,
    rootModified: number
  ): Promise<DirectoryManifest> {
    const scan = await this.scanFolderEntries(absolutePath, safeRelativePath, {
      flattenCategoryDirs: true,
      includeSubfolders: true,
    });

    const media = await this.buildMediaItems(scan.mediaCandidates);
    media.sort((a, b) => b.modified - a.modified);

    return {
      generation,
      rootModified,
      media,
      subfolders: scan.subfolders,
      subfolderCount: scan.subfolderCount,
      watchedDirectories: scan.watchedDirectories,
    };
  }

  private async restorePersistedDirectoryManifest(
    cacheKey: string,
    absolutePath: string,
    safeRelativePath: string,
    folderStat: Stats,
    generation: number,
    allowFastRestore: boolean
  ) {
    if (!this.indexStore) {
      return null;
    }

    let indexed: PersistedDirectoryManifest | null = null;
    try {
      indexed = await this.indexStore.readSnapshot<PersistedDirectoryManifest>(cacheKey);
    } catch {
      return null;
    }
    if (!indexed) {
      return null;
    }

    if (indexed.rootModified !== folderStat.mtimeMs) {
      return null;
    }

    if (!allowFastRestore) {
      const restored = await this.validatePersistedDirectoryManifest(
        absolutePath,
        safeRelativePath,
        indexed,
        folderStat
      );
      if (!restored) {
        return null;
      }

      return {
        manifest: {
          generation,
          ...restored.manifest,
        } satisfies DirectoryManifest,
        shouldPersist: restored.shouldPersist,
        revalidateInBackground: false,
        persisted: indexed,
      };
    }

    return {
      manifest: {
        generation,
        ...indexed,
      } satisfies DirectoryManifest,
      shouldPersist: false,
      revalidateInBackground: true,
      persisted: indexed,
    };
  }

  private schedulePersistedManifestValidation(
    cacheKey: string,
    absolutePath: string,
    safeRelativePath: string,
    folderStat: Stats,
    generation: number,
    persisted: PersistedDirectoryManifest
  ) {
    if (this.inFlightManifestValidations.has(cacheKey)) {
      return;
    }

    const task = (async () => {
      const restored = await this.validatePersistedDirectoryManifest(
        absolutePath,
        safeRelativePath,
        persisted,
        folderStat
      );
      if (!restored) {
        return;
      }

      if (this.getPathGeneration(safeRelativePath) !== generation) {
        return;
      }

      let nextGeneration = generation;
      if (restored.shouldPersist) {
        this.invalidatePathAndAncestors(safeRelativePath);
        nextGeneration = this.getPathGeneration(safeRelativePath);
      }
      const manifest: DirectoryManifest = {
        generation: nextGeneration,
        ...restored.manifest,
      };
      this.installManifestWatches(absolutePath, safeRelativePath, manifest);
      this.writeManifestCache(cacheKey, manifest);

      if (restored.shouldPersist) {
        await this.writeToIndex(
          cacheKey,
          this.buildManifestIndexStampFromManifest(manifest),
          this.persistDirectoryManifest(manifest)
        );
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlightManifestValidations.get(cacheKey) === task) {
          this.inFlightManifestValidations.delete(cacheKey);
        }
      });

    this.inFlightManifestValidations.set(cacheKey, task);
  }

  private async validatePersistedDirectoryManifest(
    absolutePath: string,
    safeRelativePath: string,
    persisted: PersistedDirectoryManifest,
    folderStat: Stats
  ) {
    if (persisted.rootModified !== folderStat.mtimeMs) {
      return null;
    }

    const watchedRefresh = await this.refreshPersistedWatchedDirectories(
      persisted.watchedDirectories
    );
    if (!watchedRefresh) {
      return null;
    }

    const subfolders: FolderEntryCandidate[] = [];
    for (const persistedSubfolder of persisted.subfolders) {
      const refreshed = watchedRefresh.byPath.get(persistedSubfolder.relativePath);
      if (!refreshed) {
        return null;
      }
      subfolders.push(refreshed);
    }

    const changedCategoryPaths = new Set(
      watchedRefresh.changedCategoryDirs.map((entry) => entry.relativePath)
    );
    const unchangedMedia = persisted.media.filter((item) => {
      const parentPath = path.posix.dirname(item.path);
      const normalizedParent = parentPath === "." ? "" : parentPath;
      return !changedCategoryPaths.has(normalizedParent);
    });
    const refreshedMedia = await mapWithConcurrency(
      unchangedMedia,
      this.statConcurrency,
      async (item) => this.validatePersistedMediaItem(item)
    );
    if (refreshedMedia.some((item) => !item)) {
      return null;
    }
    const media = refreshedMedia.filter((item): item is MediaItem => Boolean(item));

    const refreshedCategoryCandidates = (
      await mapWithConcurrency(
        watchedRefresh.changedCategoryDirs,
        clamp(Math.floor(this.statConcurrency / 2), 2, 8),
        async (categoryDir) =>
          this.collectDirectMediaCandidates(
            categoryDir.absolutePath,
            categoryDir.relativePath
          )
      )
    ).flat();
    if (refreshedCategoryCandidates.length > 0) {
      media.push(...(await this.buildMediaItems(refreshedCategoryCandidates)));
    }

    media.sort((a, b) => b.modified - a.modified);

    const shouldPersist =
      watchedRefresh.changedCategoryDirs.length > 0 ||
      watchedRefresh.changedSubfolders.length > 0 ||
      media.length !== persisted.media.length ||
      media.some((item, index) => {
        const previous = persisted.media[index];
        return (
          !previous ||
          previous.path !== item.path ||
          previous.modified !== item.modified ||
          previous.size !== item.size
        );
      });

    return {
      manifest: {
        rootModified: folderStat.mtimeMs,
        media,
        subfolders,
        subfolderCount: subfolders.length,
        watchedDirectories: watchedRefresh.entries,
      } satisfies PersistedDirectoryManifest,
      shouldPersist,
    };
  }

  private async refreshPersistedWatchedDirectories(
    watchedDirectories: FolderEntryCandidate[]
  ) {
    const refreshedEntries = await mapWithConcurrency(
      watchedDirectories,
      clamp(this.statConcurrency, 2, 16),
      async (entry) => ({
        original: entry,
        refreshed: await this.resolvePersistedDirectoryEntry(entry.relativePath),
      })
    );
    const entries: FolderEntryCandidate[] = [];
    const byPath = new Map<string, FolderEntryCandidate>();
    const changedCategoryDirs: FolderEntryCandidate[] = [];
    const changedSubfolders: FolderEntryCandidate[] = [];

    for (const { original, refreshed } of refreshedEntries) {
      if (!refreshed) {
        return null;
      }
      entries.push(refreshed);
      byPath.set(refreshed.relativePath, refreshed);

      if ((original.modified ?? 0) === (refreshed.modified ?? 0)) {
        continue;
      }

      if (this.categoryDirs.has(refreshed.name.toLowerCase())) {
        changedCategoryDirs.push(refreshed);
      } else {
        changedSubfolders.push(refreshed);
      }
    }

    return {
      entries,
      byPath,
      changedCategoryDirs,
      changedSubfolders,
    };
  }

  private async resolvePersistedDirectoryEntry(relativePath: string) {
    try {
      const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        return null;
      }
      return {
        name: path.posix.basename(safeRelativePath),
        absolutePath,
        relativePath: safeRelativePath,
        modified: stats.mtimeMs,
      } satisfies FolderEntryCandidate;
    } catch (error) {
      if (this.isIgnorableEntryResolutionError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async validatePersistedMediaItem(item: MediaItem) {
    try {
      const { safeRelativePath, absolutePath, kind } = await this.resolveMediaFile(item.path);
      const stats = await fs.stat(absolutePath);
      return this.buildMediaItemFromStat(
        path.basename(safeRelativePath),
        safeRelativePath,
        stats,
        kind
      );
    } catch (error) {
      if (
        this.isIgnorableEntryResolutionError(error) ||
        ((error as Error | undefined)?.message === "Unsupported media extension")
      ) {
        return null;
      }
      throw error;
    }
  }

  private async buildLightFolderSnapshot(
    absolutePath: string,
    safeRelativePath: string
  ): Promise<FolderSnapshot> {
    const scan = await this.scanFolderEntries(absolutePath, safeRelativePath, {
      flattenCategoryDirs: false,
      includeSubfolders: true,
      limitMediaCandidates: this.maxItems,
    });

    const subfolders = await mapWithConcurrency(
      scan.subfolders,
      clamp(Math.floor(this.statConcurrency / 2), 2, 16),
      async (entry) => {
        return {
          name: entry.name,
          path: entry.relativePath,
          modified: entry.modified ?? 0,
          counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
          previews: [],
          countsReady: false,
          previewReady: false,
          approximate: true,
        } satisfies FolderPreview;
      }
    );

    const rootMedia = await this.buildMediaItems(scan.mediaCandidates);

    subfolders.sort((a, b) => b.modified - a.modified);
    rootMedia.sort((a, b) => b.modified - a.modified);

    return {
      folder: {
        name: safeRelativePath
          ? path.basename(safeRelativePath)
          : path.basename(this.root),
        path: safeRelativePath,
      },
      breadcrumb: this.buildBreadcrumb(safeRelativePath),
      subfolders,
      media: rootMedia,
      totals: { media: rootMedia.length, subfolders: subfolders.length },
    };
  }

  private async buildFullFolderSnapshot(
    absolutePath: string,
    safeRelativePath: string
  ): Promise<FolderSnapshot> {
    const manifest = await this.getDirectoryManifest(absolutePath, safeRelativePath, {
      allowFastRestore: true,
    });
    const media = manifest.media;

    const previewConcurrency = clamp(Math.floor(this.statConcurrency / 2), 2, 8);
    const subfolders = await mapWithConcurrency(
      manifest.subfolders,
      previewConcurrency,
      async ({ absolutePath: childAbsolute, relativePath: childRelative }) =>
        this.getResolvedFolderPreview(
          childAbsolute,
          childRelative,
          this.previewLimit
        )
    );

    subfolders.sort((a, b) => b.modified - a.modified);

    return {
      folder: {
        name: safeRelativePath
          ? path.basename(safeRelativePath)
          : path.basename(this.root),
        path: safeRelativePath,
      },
      breadcrumb: this.buildBreadcrumb(safeRelativePath),
      subfolders,
      media,
      totals: { media: media.length, subfolders: subfolders.length },
    };
  }

  private async buildFolderPreview(
    absolutePath: string,
    relativePath: string,
    previewLimitOverride = this.previewLimit
  ): Promise<FolderPreview> {
    const counts = { images: 0, gifs: 0, videos: 0, subfolders: 0 };
    const manifest = await this.getDirectoryManifest(absolutePath, relativePath);
    counts.subfolders = manifest.subfolderCount;

    const allMedia = manifest.media;
    const limitedMedia = allMedia.slice(0, this.maxItems);
    let modified = 0;
    for (const item of allMedia) {
      this.incrementCounts(counts, item.kind);
      modified = Math.max(modified, item.modified);
    }

    if (!modified) {
      const fallback = await fs.stat(absolutePath);
      modified = fallback.mtimeMs;
    }

    const previews = limitedMedia.slice(0, previewLimitOverride);

    return {
      name: path.basename(relativePath),
      path: toPosix(relativePath),
      modified,
      counts,
      previews,
      countsReady: true,
      previewReady: true,
      approximate: false,
    };
  }

  private async buildMediaItems(candidates: MediaCandidate[]) {
    const items = await mapWithConcurrency(
      candidates,
      this.statConcurrency,
      async ({ absolutePath, kind, name, relativePath }) => {
        try {
          const stats = await fs.stat(absolutePath);
          return this.buildMediaItemFromStat(name, relativePath, stats, kind);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      }
    );

    return items.filter((item): item is MediaItem => Boolean(item));
  }

  private buildMediaItemFromStat(
    name: string,
    relativePath: string,
    stats: Stats,
    kind: MediaKind
  ): MediaItem {
    const normalized = toPosix(relativePath);
    const shouldUseThumbnail =
      kind === "video" || kind === "gif" || stats.size >= IMAGE_THUMBNAIL_MIN_BYTES;
    return {
      name,
      path: normalized,
      url: `/media/${encodePath(normalized)}`,
      thumbnailUrl: shouldUseThumbnail
        ? `/thumb/${encodePath(normalized)}?m=${Math.floor(stats.mtimeMs)}`
        : undefined,
      kind,
      size: stats.size,
      modified: stats.mtimeMs,
    };
  }

  private incrementCounts(
    counts: { images: number; gifs: number; videos: number },
    kind: MediaKind
  ) {
    if (kind === "image") counts.images += 1;
    else if (kind === "gif") counts.gifs += 1;
    else counts.videos += 1;
  }

  private buildBreadcrumb(relativePath: string) {
    const parts = toPosix(relativePath).split("/").filter(Boolean);
    const breadcrumb: { name: string; path: string }[] = [{ name: "root", path: "" }];

    parts.reduce((acc, part) => {
      const next = acc ? `${acc}/${part}` : part;
      breadcrumb.push({ name: part, path: next });
      return next;
    }, "");

    return breadcrumb;
  }

  private async buildLightIndexStamp(
    absolutePath: string,
    relativePath: string,
    folderStat: Stats
  ) {
    const tokens = [`root:${toPosix(relativePath)}:${folderStat.mtimeMs}`];

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        const token = await this.directoryStampToken(entryRelative, entryAbsolute);
        if (token) tokens.push(token);
        continue;
      }

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const token = await this.mediaStampToken(entryRelative, entryAbsolute, kind);
        if (token) tokens.push(token);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(
        entryAbsolute,
        entry.name,
        entryRelative
      );
      if (!resolved) continue;
      if ("kind" in resolved) {
        const token = await this.mediaStampToken(
          resolved.relativePath,
          resolved.absolutePath,
          resolved.kind
        );
        if (token) tokens.push(token);
        continue;
      }
      const token = await this.directoryStampToken(
        resolved.relativePath,
        resolved.absolutePath
      );
      if (token) tokens.push(token);
    }

    return this.hashIndexTokens(tokens);
  }

  private async buildPreviewIndexStamp(
    absolutePath: string,
    relativePath: string,
    folderStat: Stats
  ) {
    const tokens = [`root:${toPosix(relativePath)}:${folderStat.mtimeMs}`];
    let subfolderCount = 0;

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          tokens.push(
            ...(await this.collectDirectMediaStampTokens(entryAbsolute, entryRelative))
          );
        } else {
          subfolderCount += 1;
        }
        continue;
      }

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const token = await this.mediaStampToken(entryRelative, entryAbsolute, kind);
        if (token) tokens.push(token);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(
        entryAbsolute,
        entry.name,
        entryRelative
      );
      if (!resolved) continue;
      if ("kind" in resolved) {
        const token = await this.mediaStampToken(
          resolved.relativePath,
          resolved.absolutePath,
          resolved.kind
        );
        if (token) tokens.push(token);
        continue;
      }
      if (this.categoryDirs.has(resolved.name.toLowerCase())) {
        tokens.push(
          ...(await this.collectDirectMediaStampTokens(
            resolved.absolutePath,
            resolved.relativePath
          ))
        );
      } else {
        subfolderCount += 1;
      }
    }

    tokens.push(`subfolders:${subfolderCount}`);
    return this.hashIndexTokens(tokens);
  }

  private buildPreviewIndexStampFromManifest(
    relativePath: string,
    folderMtimeMs: number,
    manifest: DirectoryManifest
  ) {
    const tokens = [`root:${toPosix(relativePath)}:${folderMtimeMs}`];
    for (const item of manifest.media) {
      tokens.push(`m:${item.path}:${item.kind}:${item.size}:${item.modified}`);
    }
    tokens.push(`subfolders:${manifest.subfolderCount}`);
    return this.hashIndexTokens(tokens);
  }

  private buildManifestIndexStampFromManifest(manifest: DirectoryManifest) {
    const tokens = [`root:${manifest.rootModified}`];
    for (const item of manifest.media) {
      tokens.push(`m:${item.path}:${item.kind}:${item.size}:${item.modified}`);
    }
    for (const item of manifest.subfolders) {
      tokens.push(`d:${item.relativePath}:${item.modified ?? 0}`);
    }
    return this.hashIndexTokens(tokens);
  }

  private async buildManifestIndexStamp(
    absolutePath: string,
    relativePath: string,
    folderStat: Stats
  ) {
    const tokens = [`root:${toPosix(relativePath)}:${folderStat.mtimeMs}`];

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          tokens.push(
            ...(await this.collectDirectMediaStampTokens(entryAbsolute, entryRelative))
          );
        } else {
          const token = await this.directoryStampToken(entryRelative, entryAbsolute);
          if (token) tokens.push(token);
        }
        continue;
      }

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const token = await this.mediaStampToken(entryRelative, entryAbsolute, kind);
        if (token) tokens.push(token);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(
        entryAbsolute,
        entry.name,
        entryRelative
      );
      if (!resolved) continue;
      if ("kind" in resolved) {
        const token = await this.mediaStampToken(
          resolved.relativePath,
          resolved.absolutePath,
          resolved.kind
        );
        if (token) tokens.push(token);
        continue;
      }
      if (this.categoryDirs.has(resolved.name.toLowerCase())) {
        tokens.push(
          ...(await this.collectDirectMediaStampTokens(
            resolved.absolutePath,
            resolved.relativePath
          ))
        );
      } else {
        const token = await this.directoryStampToken(
          resolved.relativePath,
          resolved.absolutePath
        );
        if (token) tokens.push(token);
      }
    }

    return this.hashIndexTokens(tokens);
  }

  private async collectDirectMediaStampTokens(
    absolutePath: string,
    relativePath: string
  ): Promise<string[]> {
    const tokens: string[] = [];

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const token = await this.mediaStampToken(entryRelative, entryAbsolute, kind);
        if (token) tokens.push(token);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(
        entryAbsolute,
        entry.name,
        entryRelative
      );
      if (resolved && "kind" in resolved) {
        const token = await this.mediaStampToken(
          resolved.relativePath,
          resolved.absolutePath,
          resolved.kind
        );
        if (token) tokens.push(token);
      }
    }

    return tokens;
  }

  private async mediaStampToken(
    relativePath: string,
    absolutePath: string,
    kind: MediaKind
  ) {
    try {
      const stats = await fs.stat(absolutePath);
      return `m:${toPosix(relativePath)}:${kind}:${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async directoryStampToken(relativePath: string, absolutePath: string) {
    try {
      const stats = await fs.stat(absolutePath);
      return `d:${toPosix(relativePath)}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private hashIndexTokens(tokens: string[]) {
    const digest = createHash("sha1");
    for (const token of [...tokens].sort()) {
      digest.update(token);
      digest.update("\0");
    }
    return digest.digest("hex");
  }

  private snapshotStampForMtime(mtimeMs: number) {
    return `mtime:${mtimeMs}`;
  }

  private snapshotStampForGeneration(relativePath: string) {
    return `gen:${this.getPathGeneration(relativePath)}`;
  }

  private getPathGeneration(relativePath: string) {
    return this.pathGenerations.get(toPosix(relativePath)) ?? 0;
  }

  private bumpPathGeneration(relativePath: string) {
    const normalized = toPosix(relativePath);
    this.pathGenerations.set(
      normalized,
      (this.pathGenerations.get(normalized) ?? 0) + 1
    );
  }

  private invalidatePathAndAncestors(relativePath: string) {
    let current = toPosix(relativePath);
    this.bumpPathGeneration(current);
    while (current) {
      current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
      this.bumpPathGeneration(current);
      if (!current) break;
    }
  }

  private watchDirectory(absolutePath: string, relativePath: string) {
    if (this.watchedDirs.has(absolutePath)) {
      return;
    }
    try {
      const watcher = watchFs(absolutePath, { persistent: false }, (_eventType, filename) => {
        void this.handleWatchedDirectoryEvent(relativePath, filename).catch(() => {
          this.invalidatePathAndAncestors(relativePath);
        });
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchedDirs.delete(absolutePath);
        this.invalidatePathAndAncestors(relativePath);
      });
      this.watchedDirs.set(absolutePath, watcher);
    } catch {
      // Watching is best-effort; unsupported environments fall back to rebuild-on-request.
    }
  }

  private async *iterateVisibleEntries(absolutePath: string): AsyncGenerator<Dirent> {
    const dir = await fs.opendir(absolutePath);
    for await (const entry of dir) {
      if (!entry.name.startsWith(".")) {
        yield entry;
      }
    }
  }

  private async scanFolderEntries(
    absolutePath: string,
    relativePath: string,
    options: {
      flattenCategoryDirs: boolean;
      includeSubfolders: boolean;
      limitMediaCandidates?: number;
    }
  ): Promise<FolderScanResult> {
    const subfolders: FolderEntryCandidate[] = [];
    const categoryFolders: FolderEntryCandidate[] = [];
    const mediaCandidates: MediaCandidate[] = [];
    const watchedDirectories: FolderEntryCandidate[] = [];
    let subfolderCount = 0;

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        const candidate = await this.createFolderEntryCandidate(
          entry.name,
          entryAbsolute,
          entryRelative
        );
        if (!candidate) continue;
        watchedDirectories.push(candidate);
        if (options.flattenCategoryDirs && this.categoryDirs.has(entry.name.toLowerCase())) {
          categoryFolders.push(candidate);
        } else {
          subfolderCount += 1;
          if (options.includeSubfolders) {
            subfolders.push(candidate);
          }
        }
        continue;
      }

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (
          kind &&
          (options.limitMediaCandidates === undefined ||
            mediaCandidates.length < options.limitMediaCandidates)
        ) {
          mediaCandidates.push({
            name: entry.name,
            absolutePath: entryAbsolute,
            relativePath: entryRelative,
            kind,
          });
        }
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(entryAbsolute, entry.name, entryRelative);
      if (!resolved) continue;

      if ("kind" in resolved) {
        if (
          options.limitMediaCandidates === undefined ||
          mediaCandidates.length < options.limitMediaCandidates
        ) {
          mediaCandidates.push(resolved);
        }
        continue;
      }

      if (options.flattenCategoryDirs && this.categoryDirs.has(resolved.name.toLowerCase())) {
        watchedDirectories.push(resolved);
        categoryFolders.push(resolved);
      } else {
        watchedDirectories.push(resolved);
        subfolderCount += 1;
        if (options.includeSubfolders) {
          subfolders.push(resolved);
        }
      }
    }

    if (categoryFolders.length) {
      const categoryMediaGroups = await mapWithConcurrency(
        categoryFolders,
        clamp(Math.floor(this.statConcurrency / 2), 2, 8),
        async ({ absolutePath: categoryAbsolute, relativePath: categoryRelative }) =>
          this.collectDirectMediaCandidates(categoryAbsolute, categoryRelative)
      );
      mediaCandidates.push(...categoryMediaGroups.flat());
    }

    return {
      subfolders,
      subfolderCount,
      mediaCandidates,
      watchedDirectories,
    };
  }

  private async collectDirectMediaCandidates(
    absolutePath: string,
    relativePath: string
  ): Promise<MediaCandidate[]> {
    const candidates: MediaCandidate[] = [];

    for await (const entry of this.iterateVisibleEntries(absolutePath)) {
      const entryRelative = toPosix(
        relativePath ? `${relativePath}/${entry.name}` : entry.name
      );
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isFile()) {
        const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        candidates.push({
          name: entry.name,
          absolutePath: entryAbsolute,
          relativePath: entryRelative,
          kind,
        });
        continue;
      }

      if (!entry.isSymbolicLink()) continue;
      const resolved = await this.resolveSymbolicLinkEntry(entryAbsolute, entry.name, entryRelative);
      if (resolved && "kind" in resolved) {
        candidates.push(resolved);
      }
    }

    return candidates;
  }

  private async resolveSymbolicLinkEntry(
    lexicalAbsolutePath: string,
    name: string,
    relativePath: string
  ): Promise<FolderEntryCandidate | MediaCandidate | null> {
    try {
      const absolutePath = await this.resolvePhysicalPath(lexicalAbsolutePath);
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return {
          name,
          absolutePath,
          relativePath,
          modified: stats.mtimeMs,
        };
      }
      if (!stats.isFile()) {
        return null;
      }

      const kind = detectMediaKind(path.extname(absolutePath).toLowerCase());
      if (!kind) {
        return null;
      }

      return {
        name,
        absolutePath,
        relativePath,
        kind,
      };
    } catch (error) {
      if (this.isIgnorableEntryResolutionError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async resolvePaths(inputPath: string): Promise<ResolvedPath> {
    const normalizedInput = toPosix(inputPath || "").replace(/\0/g, "");
    const normalized = path.posix.normalize(normalizedInput);
    const safeRelativePath =
      normalized === "." ? "" : normalized.replace(/^\/+/, "");
    const lexicalAbsolutePath = path.resolve(this.root, safeRelativePath);
    this.assertInsideRoot(lexicalAbsolutePath, this.root);
    const absolutePath = await this.resolvePhysicalPath(lexicalAbsolutePath);
    return { safeRelativePath, absolutePath };
  }

  private async resolvePhysicalPath(absolutePath: string) {
    const [rootRealPath, resolvedPath] = await Promise.all([
      this.rootRealPathPromise,
      fs.realpath(absolutePath),
    ]);
    this.assertInsideRoot(resolvedPath, rootRealPath);
    return resolvedPath;
  }

  private assertInsideRoot(absolutePath: string, rootPath: string) {
    const relative = path.relative(rootPath, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path escapes media root");
    }
  }

  private isIgnorableEntryResolutionError(error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ELOOP") {
      return true;
    }
    return error instanceof Error && error.message.includes("escapes media root");
  }

  private async createFolderEntryCandidate(
    name: string,
    absolutePath: string,
    relativePath: string
  ): Promise<FolderEntryCandidate | null> {
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        return null;
      }
      return {
        name,
        absolutePath,
        relativePath,
        modified: stats.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async handleWatchedDirectoryEvent(
    watchedRelativePath: string,
    filename?: string | Buffer | null
  ) {
    const owners = this.snapshotManifestOwners(watchedRelativePath);
    this.invalidatePathAndAncestors(watchedRelativePath);

    if (!owners.length) {
      return;
    }

    const normalizedFilename = this.normalizeWatchedFilename(filename);

    await Promise.all(
      owners.map((owner) =>
        this.enqueueManifestOwnerRefresh(
          owner.key,
          owner.rootRelativePath,
          normalizedFilename
            ? {
                watchedRelativePath,
                filename: normalizedFilename,
              }
            : {
                requiresRebuild: true,
              }
        )
      )
    );
  }

  private snapshotManifestOwners(watchedRelativePath: string) {
    const ownerKeys = this.manifestOwnersByWatchedPath.get(toPosix(watchedRelativePath));
    if (!ownerKeys?.size) {
      return [];
    }

    const owners: {
      key: string;
      rootRelativePath: string;
    }[] = [];

    for (const key of ownerKeys) {
      const manifest = this.peekManifestCache(key);
      if (!manifest) continue;
      owners.push({
        key,
        rootRelativePath: this.manifestPathFromKey(key),
      });
    }

    return owners;
  }

  private normalizeWatchedFilename(filename?: string | Buffer | null) {
    if (typeof filename !== "string" && !Buffer.isBuffer(filename)) {
      return null;
    }

    const value = toPosix(String(filename)).replace(/\0/g, "");
    const normalized = path.posix.normalize(value).replace(/^\/+/, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("..") ||
      normalized.includes("/") ||
      normalized.startsWith(".")
    ) {
      return null;
    }

    return normalized;
  }

  private async enqueueManifestOwnerRefresh(
    cacheKey: string,
    rootRelativePath: string,
    input:
      | { watchedRelativePath: string; filename: string }
      | { requiresRebuild: true }
  ) {
    const pending = this.pendingManifestRefreshes.get(cacheKey) ?? {
      rootRelativePath,
      requiresRebuild: false,
      changes: [],
    };

    pending.rootRelativePath = rootRelativePath;
    if ("requiresRebuild" in input) {
      pending.requiresRebuild = true;
      pending.changes.length = 0;
    } else if (!pending.requiresRebuild) {
      pending.changes.push(input);
    }
    this.pendingManifestRefreshes.set(cacheKey, pending);

    const running = this.inFlightManifestMutations.get(cacheKey);
    if (running) {
      await running;
      return;
    }

    const task = this.drainManifestOwnerRefreshes(cacheKey).finally(() => {
      if (this.inFlightManifestMutations.get(cacheKey) === task) {
        this.inFlightManifestMutations.delete(cacheKey);
      }
    });

    this.inFlightManifestMutations.set(cacheKey, task);
    await task;
  }

  private async drainManifestOwnerRefreshes(cacheKey: string) {
    while (true) {
      const pending = this.pendingManifestRefreshes.get(cacheKey);
      if (!pending) {
        return;
      }
      this.pendingManifestRefreshes.delete(cacheKey);

      const existingManifest = this.peekManifestCache(cacheKey);
      if (!existingManifest) {
        continue;
      }

      const updatedManifest = pending.requiresRebuild
        ? await this.rebuildManifestForOwner(
            pending.rootRelativePath,
            existingManifest.generation
          )
        : await this.applyPendingManifestChanges(
            pending.rootRelativePath,
            existingManifest,
            pending.changes
          );

      if (!updatedManifest) {
        continue;
      }

      await this.persistRefreshedManifest(
        cacheKey,
        pending.rootRelativePath,
        updatedManifest
      );
    }
  }

  private async applyPendingManifestChanges(
    rootRelativePath: string,
    startingManifest: DirectoryManifest,
    changes: { watchedRelativePath: string; filename: string }[]
  ) {
    let nextManifest: DirectoryManifest | null = startingManifest;
    let changed = false;

    for (const change of changes) {
      if (!nextManifest) break;
      const updated = await this.applyManifestWatchMutation(
        rootRelativePath,
        nextManifest,
        change.watchedRelativePath,
        change.filename
      );
      if (!updated) {
        continue;
      }
      nextManifest = updated;
      changed = true;
    }

    return changed ? nextManifest : null;
  }

  private async rebuildManifestForOwner(
    rootRelativePath: string,
    previousGeneration: number
  ) {
    try {
      const { absolutePath } = await this.resolvePaths(rootRelativePath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        return null;
      }
      return this.buildDirectoryManifest(
        absolutePath,
        rootRelativePath,
        this.getPathGeneration(rootRelativePath) || previousGeneration,
        stat.mtimeMs
      );
    } catch (error) {
      if (this.isIgnorableEntryResolutionError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async persistRefreshedManifest(
    cacheKey: string,
    rootRelativePath: string,
    updatedManifest: DirectoryManifest
  ) {
    const generation = this.getPathGeneration(rootRelativePath);
    const refreshedManifest: DirectoryManifest = {
      ...updatedManifest,
      generation,
    };
    refreshedManifest.media.sort((a, b) => b.modified - a.modified);

    try {
      const { absolutePath } = await this.resolvePaths(rootRelativePath);
      const folderStat = await fs.stat(absolutePath);
      if (!folderStat.isDirectory()) {
        return;
      }
      refreshedManifest.rootModified = folderStat.mtimeMs;
      this.installManifestWatches(absolutePath, rootRelativePath, refreshedManifest);
      this.writeManifestCache(cacheKey, refreshedManifest);
      const stamp = this.buildManifestIndexStampFromManifest(refreshedManifest);
      await this.writeToIndex(
        cacheKey,
        stamp,
        this.persistDirectoryManifest(refreshedManifest)
      );
    } catch (error) {
      if (this.isIgnorableEntryResolutionError(error)) {
        return;
      }
      throw error;
    }
  }

  private async applyManifestWatchMutation(
    rootRelativePath: string,
    existingManifest: DirectoryManifest,
    watchedRelativePath: string,
    filename: string
  ): Promise<DirectoryManifest | null> {
    const changedRelativePath = toPosix(
      watchedRelativePath ? `${watchedRelativePath}/${filename}` : filename
    );

    if (watchedRelativePath !== rootRelativePath) {
      if (!this.categoryDirs.has(path.posix.basename(watchedRelativePath).toLowerCase())) {
        return null;
      }
      return this.applyCategoryDirectoryMediaMutation(
        existingManifest,
        changedRelativePath
      );
    }

    return this.applyRootDirectoryManifestMutation(
      existingManifest,
      changedRelativePath
    );
  }

  private async resolveChangedMediaItem(relativePath: string) {
    try {
      const { safeRelativePath, absolutePath, kind } = await this.resolveMediaFile(relativePath);
      const stats = await fs.stat(absolutePath);
      return this.buildMediaItemFromStat(
        path.basename(safeRelativePath),
        safeRelativePath,
        stats,
        kind
      );
    } catch (error) {
      if (
        this.isIgnorableEntryResolutionError(error) ||
        ((error as Error | undefined)?.message === "Unsupported media extension")
      ) {
        return null;
      }
      throw error;
    }
  }

  private async applyCategoryDirectoryMediaMutation(
    existingManifest: DirectoryManifest,
    changedRelativePath: string
  ): Promise<DirectoryManifest | null> {
    const hadEntry = existingManifest.media.some(
      (item) => item.path === changedRelativePath
    );
    const nextMedia = existingManifest.media.filter(
      (item) => item.path !== changedRelativePath
    );
    const nextItem = await this.resolveChangedMediaItem(changedRelativePath);
    if (nextItem) {
      nextMedia.push(nextItem);
    }

    if (!hadEntry && !nextItem) {
      return null;
    }

    return {
      generation: existingManifest.generation,
      rootModified: existingManifest.rootModified,
      media: nextMedia,
      subfolders: existingManifest.subfolders,
      subfolderCount: existingManifest.subfolderCount,
      watchedDirectories: existingManifest.watchedDirectories,
    };
  }

  private async applyRootDirectoryManifestMutation(
    existingManifest: DirectoryManifest,
    changedRelativePath: string
  ): Promise<DirectoryManifest | null> {
    const nextMediaBase = existingManifest.media.filter(
      (item) =>
        item.path !== changedRelativePath &&
        !item.path.startsWith(`${changedRelativePath}/`)
    );
    const nextSubfoldersBase = existingManifest.subfolders.filter(
      (item) => item.relativePath !== changedRelativePath
    );
    const nextWatchedBase = existingManifest.watchedDirectories.filter(
      (item) => item.relativePath !== changedRelativePath
    );

    const removedAnything =
      nextMediaBase.length !== existingManifest.media.length ||
      nextSubfoldersBase.length !== existingManifest.subfolders.length ||
      nextWatchedBase.length !== existingManifest.watchedDirectories.length;

    const resolved = await this.resolveChangedManifestEntry(changedRelativePath);
    if (!resolved) {
      if (!removedAnything) {
        return null;
      }
      return {
        generation: existingManifest.generation,
        rootModified: existingManifest.rootModified,
        media: nextMediaBase,
        subfolders: nextSubfoldersBase,
        subfolderCount: nextSubfoldersBase.length,
        watchedDirectories: nextWatchedBase,
      };
    }

    if (resolved.type === "media") {
      return {
        generation: existingManifest.generation,
        rootModified: existingManifest.rootModified,
        media: [...nextMediaBase, resolved.item],
        subfolders: nextSubfoldersBase,
        subfolderCount: nextSubfoldersBase.length,
        watchedDirectories: nextWatchedBase,
      };
    }

    if (resolved.type === "subfolder") {
      return {
        generation: existingManifest.generation,
        rootModified: existingManifest.rootModified,
        media: nextMediaBase,
        subfolders: [...nextSubfoldersBase, resolved.entry],
        subfolderCount: nextSubfoldersBase.length + 1,
        watchedDirectories: [...nextWatchedBase, resolved.entry],
      };
    }

    return {
      generation: existingManifest.generation,
      rootModified: existingManifest.rootModified,
      media: [...nextMediaBase, ...resolved.media],
      subfolders: nextSubfoldersBase,
      subfolderCount: nextSubfoldersBase.length,
      watchedDirectories: [...nextWatchedBase, resolved.entry],
    };
  }

  private async resolveChangedManifestEntry(relativePath: string): Promise<
    | { type: "media"; item: MediaItem }
    | { type: "subfolder"; entry: FolderEntryCandidate }
    | { type: "category"; entry: FolderEntryCandidate; media: MediaItem[] }
    | null
  > {
    try {
      const { safeRelativePath, absolutePath } = await this.resolvePaths(relativePath);
      const stats = await fs.stat(absolutePath);
      const name = path.posix.basename(safeRelativePath);

      if (stats.isDirectory()) {
        const entry: FolderEntryCandidate = {
          name,
          absolutePath,
          relativePath: safeRelativePath,
          modified: stats.mtimeMs,
        };

        if (this.categoryDirs.has(name.toLowerCase())) {
          const candidates = await this.collectDirectMediaCandidates(
            absolutePath,
            safeRelativePath
          );
          const media = await this.buildMediaItems(candidates);
          media.sort((a, b) => b.modified - a.modified);
          return {
            type: "category",
            entry,
            media,
          };
        }

        return {
          type: "subfolder",
          entry,
        };
      }

      if (!stats.isFile()) {
        return null;
      }

      const kind = detectMediaKind(path.extname(absolutePath).toLowerCase());
      if (!kind) {
        return null;
      }

      return {
        type: "media",
        item: this.buildMediaItemFromStat(name, safeRelativePath, stats, kind),
      };
    } catch (error) {
      if (
        this.isIgnorableEntryResolutionError(error) ||
        ((error as Error | undefined)?.message === "Unsupported media extension")
      ) {
        return null;
      }
      throw error;
    }
  }

  private readSnapshotCache(key: string, stamp: string) {
    const cached = this.snapshotCache.get(key);
    if (!cached) return null;
    if (cached.stamp !== stamp) {
      this.deleteSnapshotCacheKey(key);
      return null;
    }

    if (Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.deleteSnapshotCacheKey(key);
      return null;
    }

    this.snapshotCache.delete(key);
    this.snapshotCache.set(key, cached);
    return cached.snapshot;
  }

  private writeSnapshotCache(key: string, stamp: string, snapshot: FolderSnapshot) {
    const existing = this.snapshotCache.get(key);
    if (existing) {
      this.snapshotCacheTotalBytes -= existing.approxBytes;
      this.snapshotCache.delete(key);
    }

    const approxBytes = this.estimateSnapshotBytes(snapshot);
    this.snapshotCache.set(key, {
      stamp,
      createdAt: Date.now(),
      snapshot,
      approxBytes,
    });
    this.snapshotCacheTotalBytes += approxBytes;

    while (
      this.snapshotCache.size > this.cacheMaxEntries ||
      this.snapshotCacheTotalBytes > this.cacheMaxBytes
    ) {
      const oldest = this.snapshotCache.keys().next().value;
      if (!oldest) break;
      this.deleteSnapshotCacheKey(oldest);
    }
  }

  private deleteSnapshotCacheKey(key: string) {
    const existing = this.snapshotCache.get(key);
    if (!existing) return;
    this.snapshotCacheTotalBytes -= existing.approxBytes;
    this.snapshotCache.delete(key);
  }

  private readPreviewCache(key: string, generation: number) {
    const cached = this.previewCache.get(key);
    if (!cached) return null;
    if (cached.generation !== generation) {
      this.deletePreviewCacheKey(key);
      return null;
    }
    if (Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.deletePreviewCacheKey(key);
      return null;
    }
    this.previewCache.delete(key);
    this.previewCache.set(key, cached);
    return cached.preview;
  }

  private writePreviewCache(key: string, generation: number, preview: FolderPreview) {
    const existing = this.previewCache.get(key);
    if (existing) {
      this.previewCacheTotalBytes -= existing.approxBytes;
      this.previewCache.delete(key);
    }

    const approxBytes = estimateFolderPreviewBytes(preview);
    this.previewCache.set(key, {
      generation,
      createdAt: Date.now(),
      preview,
      approxBytes,
    });
    this.previewCacheTotalBytes += approxBytes;

    const previewCacheMaxEntries = Math.max(this.cacheMaxEntries * 2, 256);
    const previewCacheMaxBytes = Math.max(
      32 * 1024 * 1024,
      Math.floor(this.cacheMaxBytes / 3)
    );

    while (
      this.previewCache.size > previewCacheMaxEntries ||
      this.previewCacheTotalBytes > previewCacheMaxBytes
    ) {
      const oldest = this.previewCache.keys().next().value;
      if (!oldest) break;
      this.deletePreviewCacheKey(oldest);
    }
  }

  private deletePreviewCacheKey(key: string) {
    const existing = this.previewCache.get(key);
    if (!existing) return;
    this.previewCacheTotalBytes -= existing.approxBytes;
    this.previewCache.delete(key);
  }

  private readManifestCache(key: string, generation: number) {
    const cached = this.manifestCache.get(key);
    if (!cached) return null;
    if (cached.generation !== generation) {
      this.deleteManifestCacheKey(key);
      return null;
    }
    if (Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.deleteManifestCacheKey(key);
      return null;
    }
    this.manifestCache.delete(key);
    this.manifestCache.set(key, cached);
    return cached;
  }

  private peekManifestCache(key: string) {
    const cached = this.manifestCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.deleteManifestCacheKey(key);
      return null;
    }
    return cached;
  }

  private persistDirectoryManifest(
    manifest: DirectoryManifest
  ): PersistedDirectoryManifest {
    return {
      rootModified: manifest.rootModified,
      media: manifest.media,
      subfolders: manifest.subfolders,
      subfolderCount: manifest.subfolderCount,
      watchedDirectories: manifest.watchedDirectories,
    };
  }

  private installManifestWatches(
    absolutePath: string,
    relativePath: string,
    manifest: Pick<DirectoryManifest, "watchedDirectories">
  ) {
    this.watchDirectory(absolutePath, relativePath);
    for (const directory of manifest.watchedDirectories) {
      this.watchDirectory(directory.absolutePath, directory.relativePath);
    }
  }

  private manifestPathFromKey(key: string) {
    const prefix = `${MediaScanner.CACHE_VERSION}:manifest:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : "";
  }

  private registerManifestOwner(
    key: string,
    manifest: Pick<DirectoryManifest, "watchedDirectories">
  ) {
    const watchedPaths = new Set([
      toPosix(this.manifestPathFromKey(key)),
      ...manifest.watchedDirectories.map((item) => toPosix(item.relativePath)),
    ]);

    for (const watchedPath of watchedPaths) {
      const owners = this.manifestOwnersByWatchedPath.get(watchedPath) ?? new Set<string>();
      owners.add(key);
      this.manifestOwnersByWatchedPath.set(watchedPath, owners);
    }
  }

  private unregisterManifestOwner(
    key: string,
    manifest: Pick<DirectoryManifest, "watchedDirectories">
  ) {
    const watchedPaths = new Set([
      toPosix(this.manifestPathFromKey(key)),
      ...manifest.watchedDirectories.map((item) => toPosix(item.relativePath)),
    ]);

    for (const watchedPath of watchedPaths) {
      const owners = this.manifestOwnersByWatchedPath.get(watchedPath);
      if (!owners) continue;
      owners.delete(key);
      if (!owners.size) {
        this.manifestOwnersByWatchedPath.delete(watchedPath);
      }
    }
  }

  private writeManifestCache(key: string, manifest: DirectoryManifest) {
    const existing = this.manifestCache.get(key);
    if (existing) {
      this.manifestCacheTotalBytes -= existing.approxBytes;
      this.unregisterManifestOwner(key, existing);
      this.manifestCache.delete(key);
    }

    const approxBytes = this.estimateManifestBytes(manifest);
    this.manifestCache.set(key, {
      ...manifest,
      createdAt: Date.now(),
      approxBytes,
    });
    this.manifestCacheTotalBytes += approxBytes;
    this.registerManifestOwner(key, manifest);

    const manifestCacheMaxEntries = Math.max(this.cacheMaxEntries, 128);
    const manifestCacheMaxBytes = Math.max(
      48 * 1024 * 1024,
      Math.floor(this.cacheMaxBytes / 2)
    );

    while (
      this.manifestCache.size > manifestCacheMaxEntries ||
      this.manifestCacheTotalBytes > manifestCacheMaxBytes
    ) {
      const oldest = this.manifestCache.keys().next().value;
      if (!oldest) break;
      this.deleteManifestCacheKey(oldest);
    }
  }

  private deleteManifestCacheKey(key: string) {
    const existing = this.manifestCache.get(key);
    if (!existing) return;
    this.manifestCacheTotalBytes -= existing.approxBytes;
    this.unregisterManifestOwner(key, existing);
    this.manifestCache.delete(key);
  }

  private estimateManifestBytes(manifest: DirectoryManifest) {
    return (
      512 +
      estimateNumberBytes(manifest.generation) +
      estimateNumberBytes(manifest.rootModified) +
      manifest.subfolders.reduce(
        (sum, item) =>
          sum +
          48 +
          estimateStringBytes(item.name) +
          estimateStringBytes(item.absolutePath) +
          estimateStringBytes(item.relativePath) +
          estimateNumberBytes(item.modified ?? 0),
        0
      ) +
      estimateNumberBytes(manifest.subfolderCount) +
      manifest.watchedDirectories.reduce(
        (sum, item) =>
          sum +
          48 +
          estimateStringBytes(item.name) +
          estimateStringBytes(item.absolutePath) +
          estimateStringBytes(item.relativePath) +
          estimateNumberBytes(item.modified ?? 0),
        0
      ) +
      manifest.media.reduce((sum, item) => sum + estimateMediaItemBytes(item), 0)
    );
  }

  private estimateSnapshotBytes(snapshot: FolderSnapshot) {
    return (
      1024 +
      estimateStringBytes(snapshot.folder.name) +
      estimateStringBytes(snapshot.folder.path) +
      snapshot.breadcrumb.reduce(
        (sum, item) =>
          sum + 32 + estimateStringBytes(item.name) + estimateStringBytes(item.path),
        0
      ) +
      snapshot.subfolders.reduce(
        (sum, item) => sum + estimateFolderPreviewBytes(item),
        0
      ) +
      snapshot.media.reduce((sum, item) => sum + estimateMediaItemBytes(item), 0) +
      estimateNumberBytes(snapshot.totals.media) +
      estimateNumberBytes(snapshot.totals.subfolders)
    );
  }
}
