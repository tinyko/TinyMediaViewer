import fs from "fs/promises";
import { Dirent, Stats } from "fs";
import path from "path";
import { IndexStore } from "./index_store";

export type MediaKind = "image" | "gif" | "video";
export type FolderMode = "light" | "full";

export interface MediaItem {
  name: string;
  path: string;
  url: string;
  kind: MediaKind;
  size: number;
  modified: number;
}

export interface FolderPreview {
  name: string;
  path: string;
  modified: number;
  counts: {
    images: number;
    gifs: number;
    videos: number;
    subfolders: number;
  };
  previews: MediaItem[];
  countsReady: boolean;
  previewReady: boolean;
  approximate?: boolean;
}

export interface FolderPayload {
  folder: {
    name: string;
    path: string;
  };
  breadcrumb: { name: string; path: string }[];
  subfolders: FolderPreview[];
  media: MediaItem[];
  totals: { media: number; subfolders: number };
  nextCursor?: string;
}

export interface FolderPreviewBatchError {
  path: string;
  error: string;
}

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
  mtimeMs: number;
  createdAt: number;
  snapshot: FolderSnapshot;
  approxBytes: number;
}

const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]);
const videoExts = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"]);
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

const parseCursor = (cursor?: string) => {
  if (!cursor) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new Error("Invalid cursor");
  }
  return Number(cursor);
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
  private static readonly INDEX_VERSION = 1;

  private readonly root: string;
  private readonly indexStore?: IndexStore<FolderSnapshot>;
  private cache = new Map<string, CacheEntry>();
  private cacheTotalBytes = 0;
  private inFlightScans = new Map<string, Promise<FolderSnapshot>>();
  private inFlightPreviews = new Map<string, Promise<FolderPreview>>();
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
    if (enableIndexPersist) {
      this.indexStore = new IndexStore<FolderSnapshot>({
        dir: indexDir,
        maxBytes: indexMaxBytes,
        version: MediaScanner.INDEX_VERSION,
      });
    }
  }

  async getFolder(
    relativePath = "",
    options: { cursor?: string; limit?: number; mode?: FolderMode } = {}
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

    if (cursor > snapshot.media.length) {
      throw new Error("Cursor exceeds media item count");
    }

    const pageMedia = snapshot.media.slice(cursor, cursor + limit);
    const nextIndex = cursor + pageMedia.length;
    const nextCursor =
      nextIndex < snapshot.media.length ? String(nextIndex) : undefined;

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

  resolveMediaFile(relativePath: string) {
    const { safeRelativePath, absolutePath } = this.resolvePaths(relativePath);
    if (!safeRelativePath) {
      throw new Error("Missing media file path");
    }
    const ext = path.extname(safeRelativePath).toLowerCase();
    const kind = detectMediaKind(ext);
    if (!kind) {
      throw new Error("Unsupported media extension");
    }
    return { safeRelativePath, absolutePath, kind };
  }

  private async getFullFolderSnapshot(relativePath: string): Promise<FolderSnapshot> {
    const { safeRelativePath, absolutePath } = this.resolvePaths(relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const cacheKey = this.snapshotKey("full", safeRelativePath);
    const cached = this.readCache(cacheKey, stat.mtimeMs);
    if (cached) return cached;

    const running = this.inFlightScans.get(cacheKey);
    if (running) return running;

    const task = (async () => {
      const indexed = await this.readFromIndex(cacheKey, stat.mtimeMs);
      if (indexed) {
        this.writeCache(cacheKey, stat.mtimeMs, indexed);
        return indexed;
      }

      const snapshot = await this.buildFullFolderSnapshot(
        absolutePath,
        safeRelativePath
      );
      this.writeCache(cacheKey, stat.mtimeMs, snapshot);
      await this.writeToIndex(cacheKey, stat.mtimeMs, snapshot);
      return snapshot;
    })().finally(() => {
      this.inFlightScans.delete(cacheKey);
    });

    this.inFlightScans.set(cacheKey, task);
    return task;
  }

  private async getLightFolderSnapshot(relativePath: string): Promise<FolderSnapshot> {
    const { safeRelativePath, absolutePath } = this.resolvePaths(relativePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const cacheKey = this.snapshotKey("light", safeRelativePath);
    const cached = this.readCache(cacheKey, stat.mtimeMs);
    if (cached) return cached;

    const running = this.inFlightScans.get(cacheKey);
    if (running) return running;

    const task = this.buildLightFolderSnapshot(absolutePath, safeRelativePath)
      .then((snapshot) => {
        this.writeCache(cacheKey, stat.mtimeMs, snapshot);
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
    const inFlightKey = `${relativePath}::${previewLimitOverride}`;
    const running = this.inFlightPreviews.get(inFlightKey);
    if (running) return running;

    const task = (async () => {
      const { safeRelativePath, absolutePath } = this.resolvePaths(relativePath);
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        throw new Error("Requested path is not a directory");
      }
      return this.buildFolderPreview(
        absolutePath,
        safeRelativePath,
        previewLimitOverride
      );
    })().finally(() => {
      this.inFlightPreviews.delete(inFlightKey);
    });

    this.inFlightPreviews.set(inFlightKey, task);
    return task;
  }

  private async readFromIndex(cacheKey: string, mtimeMs: number) {
    if (!this.indexStore) return null;
    try {
      return await this.indexStore.readSnapshot(cacheKey, mtimeMs);
    } catch {
      return null;
    }
  }

  private async writeToIndex(
    cacheKey: string,
    mtimeMs: number,
    snapshot: FolderSnapshot
  ) {
    if (!this.indexStore) return;
    try {
      await this.indexStore.writeSnapshot(cacheKey, mtimeMs, snapshot);
    } catch {
      // Index persistence failure should not break runtime scans.
    }
  }

  private snapshotKey(mode: FolderMode, safeRelativePath: string) {
    return `${MediaScanner.CACHE_VERSION}:${mode}:${safeRelativePath}`;
  }

  private async buildLightFolderSnapshot(
    absolutePath: string,
    safeRelativePath: string
  ): Promise<FolderSnapshot> {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
    const subfolderEntries = visibleEntries.filter((entry) => entry.isDirectory());
    const mediaEntries = visibleEntries.filter((entry) => {
      if (!entry.isFile()) return false;
      return Boolean(detectMediaKind(path.extname(entry.name).toLowerCase()));
    });

    const subfolders = await mapWithConcurrency(
      subfolderEntries,
      clamp(Math.floor(this.statConcurrency / 2), 2, 16),
      async (entry) => {
        const childRelative = safeRelativePath
          ? `${safeRelativePath}/${entry.name}`
          : entry.name;
        const childAbsolute = path.join(absolutePath, entry.name);
        let modified = 0;
        try {
          modified = (await fs.stat(childAbsolute)).mtimeMs;
        } catch {
          // Keep default modified=0 for deleted directories in race windows.
        }

        return {
          name: entry.name,
          path: toPosix(childRelative),
          modified,
          counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
          previews: [],
          countsReady: false,
          previewReady: false,
          approximate: true,
        } satisfies FolderPreview;
      }
    );

    const rootMedia = await this.buildMediaItems(
      mediaEntries.slice(0, this.maxItems),
      absolutePath,
      safeRelativePath
    );

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
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = dirents.filter((entry) => !entry.name.startsWith("."));
    const subfolderJobs: Array<{ absolutePath: string; relativePath: string }> = [];
    const categoryJobs: Array<{ absolutePath: string; relativePath: string }> = [];
    const rootMediaEntries: Dirent[] = [];

    for (const entry of visibleEntries) {
      const entryRelative = safeRelativePath
        ? `${safeRelativePath}/${entry.name}`
        : entry.name;
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          categoryJobs.push({ absolutePath: entryAbsolute, relativePath: entryRelative });
        } else {
          subfolderJobs.push({ absolutePath: entryAbsolute, relativePath: entryRelative });
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
      if (!kind) continue;
      rootMediaEntries.push(entry);
    }

    const media: MediaItem[] = [];
    let processed = 0;

    const rootLimit = Math.max(0, this.maxItems - processed);
    if (rootLimit > 0) {
      const rootMediaItems = await this.buildMediaItems(
        rootMediaEntries.slice(0, rootLimit),
        absolutePath,
        safeRelativePath
      );
      media.push(...rootMediaItems);
      processed += rootMediaItems.length;
    }

    for (const category of categoryJobs) {
      const remaining = Math.max(0, this.maxItems - processed);
      if (!remaining) break;
      const categoryMedia = await this.collectCategoryMedia(
        category.absolutePath,
        category.relativePath,
        remaining
      );
      media.push(...categoryMedia);
      processed += categoryMedia.length;
    }

    const previewConcurrency = clamp(Math.floor(this.statConcurrency / 2), 2, 8);
    const subfolders = await mapWithConcurrency(
      subfolderJobs,
      previewConcurrency,
      async ({ absolutePath: childAbsolute, relativePath: childRelative }) =>
        this.buildFolderPreview(childAbsolute, childRelative)
    );

    subfolders.sort((a, b) => b.modified - a.modified);
    media.sort((a, b) => b.modified - a.modified);

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
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !entry.name.startsWith("."));
    const localMediaEntries: Dirent[] = [];
    const categoryJobs: Array<{ absolutePath: string; relativePath: string }> = [];
    const counts = { images: 0, gifs: 0, videos: 0, subfolders: 0 };
    let modified = 0;
    let processed = 0;
    const previewCandidates: MediaItem[] = [];

    for (const entry of visibleEntries) {
      const entryAbsolute = path.join(absolutePath, entry.name);
      const entryRelative = toPosix(path.join(relativePath, entry.name));

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          categoryJobs.push({ absolutePath: entryAbsolute, relativePath: entryRelative });
        } else {
          counts.subfolders += 1;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
      if (!kind) continue;
      localMediaEntries.push(entry);
    }

    const localLimit = Math.max(0, this.maxItems - processed);
    const localItems = await this.buildMediaItems(
      localMediaEntries.slice(0, localLimit),
      absolutePath,
      relativePath
    );
    processed += localItems.length;
    for (const item of localItems) {
      this.incrementCounts(counts, item.kind);
      modified = Math.max(modified, item.modified);
    }
    previewCandidates.push(...localItems);

    for (const category of categoryJobs) {
      const remaining = Math.max(0, this.maxItems - processed);
      if (!remaining) break;
      const previewLimit = Math.max(
        0,
        previewLimitOverride - previewCandidates.length
      );
      const categoryPreview = await this.collectCategoryPreview(
        category.absolutePath,
        category.relativePath,
        previewLimit,
        remaining
      );

      counts.images += categoryPreview.counts.images;
      counts.gifs += categoryPreview.counts.gifs;
      counts.videos += categoryPreview.counts.videos;
      processed += categoryPreview.counted;
      modified = Math.max(modified, categoryPreview.modified);
      previewCandidates.push(...categoryPreview.previews);
    }

    if (!modified) {
      const fallback = await fs.stat(absolutePath);
      modified = fallback.mtimeMs;
    }

    const previews = previewCandidates
      .sort((a, b) => b.modified - a.modified)
      .slice(0, previewLimitOverride);

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

  private async collectCategoryMedia(
    absolutePath: string,
    relativePath: string,
    limit: number
  ) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const candidates = entries.filter((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (!entry.isFile()) return false;
      return Boolean(detectMediaKind(path.extname(entry.name).toLowerCase()));
    });

    return this.buildMediaItems(candidates.slice(0, limit), absolutePath, relativePath);
  }

  private async collectCategoryPreview(
    absolutePath: string,
    relativePath: string,
    previewLimit: number,
    countLimit: number
  ) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const candidates = entries.filter((entry) => {
      if (entry.name.startsWith(".")) return false;
      if (!entry.isFile()) return false;
      return Boolean(detectMediaKind(path.extname(entry.name).toLowerCase()));
    });

    const items = await this.buildMediaItems(
      candidates.slice(0, countLimit),
      absolutePath,
      relativePath
    );
    const counts = { images: 0, gifs: 0, videos: 0 };
    let modified = 0;
    for (const item of items) {
      this.incrementCounts(counts, item.kind);
      modified = Math.max(modified, item.modified);
    }

    return {
      previews: items.sort((a, b) => b.modified - a.modified).slice(0, previewLimit),
      counts,
      counted: items.length,
      modified,
    };
  }

  private async buildMediaItems(
    entries: Dirent[],
    parentAbsolutePath: string,
    parentRelativePath: string
  ) {
    const candidates = entries
      .map((entry) => ({
        entry,
        kind: detectMediaKind(path.extname(entry.name).toLowerCase()),
      }))
      .filter(
        (item): item is { entry: Dirent; kind: MediaKind } =>
          item.entry.isFile() && Boolean(item.kind)
      );

    const items = await mapWithConcurrency(
      candidates,
      this.statConcurrency,
      async ({ entry, kind }) => {
        const absolutePath = path.join(parentAbsolutePath, entry.name);
        try {
          const stats = await fs.stat(absolutePath);
          const relativePath = parentRelativePath
            ? `${parentRelativePath}/${entry.name}`
            : entry.name;
          return this.buildMediaItemFromStat(entry.name, relativePath, stats, kind);
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
    return {
      name,
      path: normalized,
      url: `/media/${encodePath(normalized)}`,
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

  private resolvePaths(inputPath: string) {
    const normalizedInput = toPosix(inputPath || "").replace(/\0/g, "");
    const normalized = path.posix.normalize(normalizedInput);
    const safeRelativePath =
      normalized === "." ? "" : normalized.replace(/^\/+/, "");
    const absolutePath = path.resolve(this.root, safeRelativePath);
    this.assertInsideRoot(absolutePath);
    return { safeRelativePath, absolutePath };
  }

  private assertInsideRoot(absolutePath: string) {
    const relative = path.relative(this.root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path escapes media root");
    }
  }

  private readCache(key: string, mtimeMs: number) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.mtimeMs !== mtimeMs) {
      this.deleteCacheKey(key);
      return null;
    }

    if (Date.now() - cached.createdAt > this.cacheTtlMs) {
      this.deleteCacheKey(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.snapshot;
  }

  private writeCache(key: string, mtimeMs: number, snapshot: FolderSnapshot) {
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheTotalBytes -= existing.approxBytes;
      this.cache.delete(key);
    }

    const approxBytes = this.estimateSnapshotBytes(snapshot);
    this.cache.set(key, {
      mtimeMs,
      createdAt: Date.now(),
      snapshot,
      approxBytes,
    });
    this.cacheTotalBytes += approxBytes;

    while (
      this.cache.size > this.cacheMaxEntries ||
      this.cacheTotalBytes > this.cacheMaxBytes
    ) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.deleteCacheKey(oldest);
    }
  }

  private deleteCacheKey(key: string) {
    const existing = this.cache.get(key);
    if (!existing) return;
    this.cacheTotalBytes -= existing.approxBytes;
    this.cache.delete(key);
  }

  private estimateSnapshotBytes(snapshot: FolderSnapshot) {
    try {
      return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    } catch {
      return (
        2048 +
        snapshot.media.length * 196 +
        snapshot.subfolders.length * 320 +
        snapshot.breadcrumb.length * 80
      );
    }
  }
}
