import fs from "fs/promises";
import { Stats } from "fs";
import path from "path";

export type MediaKind = "image" | "gif" | "video";

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
}

export interface FolderPayload {
  folder: {
    name: string;
    path: string;
    absolutePath: string;
  };
  breadcrumb: { name: string; path: string }[];
  subfolders: FolderPreview[];
  media: MediaItem[];
  totals: { media: number; subfolders: number };
}

const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]);
const videoExts = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"]);

interface CacheEntry {
  mtimeMs: number;
  data: FolderPayload;
}

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

export class MediaScanner {
  private cache = new Map<string, CacheEntry>();
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
    private readonly root: string,
    private readonly previewLimit: number,
    private readonly maxItems: number
  ) {}

  async getFolder(relativePath = ""): Promise<FolderPayload> {
    const { safeRelativePath, absolutePath } = this.resolvePaths(relativePath);
    const stat = await fs.stat(absolutePath);

    if (!stat.isDirectory()) {
      throw new Error("Requested path is not a directory");
    }

    const cached = this.cache.get(safeRelativePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }

    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const subfolders: FolderPreview[] = [];
    const media: MediaItem[] = [];
    let processed = 0;

    for (const entry of dirents) {
      if (entry.name.startsWith(".")) continue;
      if (processed >= this.maxItems) break;

      const entryRelative = safeRelativePath
        ? `${safeRelativePath}/${entry.name}`
        : entry.name;
      const entryAbsolute = path.join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          const remaining = this.maxItems - processed;
          if (remaining <= 0) break;
          const added = await this.collectCategoryMedia(
            entryAbsolute,
            entryRelative,
            media,
            remaining
          );
          processed += added;
        } else {
          const preview = await this.buildFolderPreview(
            entryAbsolute,
            entryRelative
          );
          subfolders.push(preview);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const kind = detectMediaKind(ext);
      if (!kind) continue;

      const item = await this.createMediaItem(entryAbsolute, entryRelative, kind);
      media.push(item);
      processed += 1;
    }

    subfolders.sort((a, b) => b.modified - a.modified);
    media.sort((a, b) => b.modified - a.modified);

    const payload: FolderPayload = {
      folder: {
        name: safeRelativePath ? path.basename(safeRelativePath) : path.basename(this.root),
        path: safeRelativePath,
        absolutePath,
      },
      breadcrumb: this.buildBreadcrumb(safeRelativePath),
      subfolders,
      media,
      totals: { media: media.length, subfolders: subfolders.length },
    };

    this.cache.set(safeRelativePath, { mtimeMs: stat.mtimeMs, data: payload });
    return payload;
  }

  private async buildFolderPreview(
    absolutePath: string,
    relativePath: string
  ): Promise<FolderPreview> {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const previews: MediaItem[] = [];
    const counts = { images: 0, gifs: 0, videos: 0, subfolders: 0 };
    let modified = 0;
    let processed = 0;

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryAbsolute = path.join(absolutePath, entry.name);
      const entryRelative = toPosix(path.join(relativePath, entry.name));
      const stats = await fs.stat(entryAbsolute);
      modified = Math.max(modified, stats.mtimeMs);

      if (entry.isDirectory()) {
        if (this.categoryDirs.has(entry.name.toLowerCase())) {
          const remaining = this.previewLimit - previews.length;
          if (remaining > 0) {
            const previewAdded = await this.collectCategoryPreview(
              entryAbsolute,
              entryRelative,
              previews,
              counts,
              remaining
            );
            processed += previewAdded;
          }
        } else {
          counts.subfolders += 1;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
      if (!kind) continue;

      if (kind === "gif") counts.videos += 1;
      else if (kind === "image") counts.images += 1;
      else counts.videos += 1;
      processed += 1;

      if (previews.length < this.previewLimit) {
        previews.push(
          this.buildMediaItemFromStat(entry.name, entryRelative, stats, kind)
        );
      }
    }

    if (!modified) {
      const fallback = await fs.stat(absolutePath);
      modified = fallback.mtimeMs;
    }

    return {
      name: path.basename(relativePath),
      path: toPosix(relativePath),
      modified,
      counts,
      previews,
    };
  }

  private async createMediaItem(
    absolutePath: string,
    relativePath: string,
    kind: MediaKind
  ): Promise<MediaItem> {
    const stats = await fs.stat(absolutePath);
    const name = path.basename(absolutePath);
    return this.buildMediaItemFromStat(name, relativePath, stats, kind);
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

  private async collectCategoryMedia(
    absolutePath: string,
    relativePath: string,
    media: MediaItem[],
    limit: number
  ) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    let added = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (added >= limit) break;
      const entryAbsolute = path.join(absolutePath, entry.name);
      const stats = await fs.stat(entryAbsolute);
      if (!entry.isFile()) continue;
      const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
      if (!kind) continue;
      const rel = toPosix(path.join(relativePath, entry.name));
      media.push(this.buildMediaItemFromStat(entry.name, rel, stats, kind));
      added += 1;
    }
    return added;
  }

  private async collectCategoryPreview(
    absolutePath: string,
    relativePath: string,
    previews: MediaItem[],
    counts: FolderPreview["counts"],
    limit: number
  ) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    let added = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryAbsolute = path.join(absolutePath, entry.name);
      const stats = await fs.stat(entryAbsolute);
      if (!entry.isFile()) continue;
      const kind = detectMediaKind(path.extname(entry.name).toLowerCase());
      if (!kind) continue;
      if (kind === "gif") counts.videos += 1;
      else if (kind === "image") counts.images += 1;
      else counts.videos += 1;
      if (added < limit) {
        const rel = toPosix(path.join(relativePath, entry.name));
        previews.push(this.buildMediaItemFromStat(entry.name, rel, stats, kind));
        added += 1;
      }
    }
    return added;
  }

  private buildBreadcrumb(relativePath: string) {
    const parts = toPosix(relativePath).split("/").filter(Boolean);
    const breadcrumb: { name: string; path: string }[] = [
      { name: "root", path: "" },
    ];

    parts.reduce((acc, part) => {
      const next = acc ? `${acc}/${part}` : part;
      breadcrumb.push({ name: part, path: next });
      return next;
    }, "");

    return breadcrumb;
  }

  private resolvePaths(inputPath: string) {
    const normalized =
      inputPath && inputPath !== "."
        ? toPosix(path.normalize(inputPath).replace(/^(\.\.(\/|\\))+/g, ""))
        : "";

    const safeRelativePath = normalized === "." ? "" : normalized.replace(/^\/+/, "");
    const absolutePath = path.resolve(this.root, safeRelativePath);

    if (!absolutePath.startsWith(this.root)) {
      throw new Error("Path escapes media root");
    }

    return { safeRelativePath, absolutePath };
  }
}
