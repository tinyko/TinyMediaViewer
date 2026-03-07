import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";

type ThumbnailMediaKind = "image" | "gif" | "video";

interface ThumbnailMeta {
  sourcePath: string;
  sourceModifiedMs: number;
  generatedAt: number;
}

export class VideoThumbnailCache {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly pending: Array<() => void> = [];
  private activeJobs = 0;

  constructor(
    private readonly cacheDir: string,
    private readonly ffmpegBin: string,
    private readonly maxConcurrentJobs = 1
  ) {}

  async getThumbnail(
    relativePath: string,
    absolutePath: string,
    modifiedMs: number,
    kind: ThumbnailMediaKind
  ): Promise<string> {
    const cacheKey = this.buildCacheKey(relativePath);
    const running = this.inFlight.get(cacheKey);
    if (running) return running;

    const task = this.ensureThumbnail(
      cacheKey,
      relativePath.replace(/\\/g, "/"),
      absolutePath,
      Math.floor(modifiedMs),
      kind
    ).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, task);
    return task;
  }

  private async ensureThumbnail(
    cacheKey: string,
    relativePath: string,
    absolutePath: string,
    sourceModifiedMs: number,
    kind: ThumbnailMediaKind
  ) {
    await fs.mkdir(this.cacheDir, { recursive: true });

    const outputPath = path.join(this.cacheDir, `${cacheKey}.jpg`);
    const tempOutputPath = path.join(this.cacheDir, `${cacheKey}.tmp.jpg`);
    const metaPath = path.join(this.cacheDir, `${cacheKey}.json`);
    const meta = await this.readMeta(metaPath);

    if (
      meta?.sourcePath === relativePath &&
      meta.sourceModifiedMs === sourceModifiedMs &&
      (await this.fileExists(outputPath))
    ) {
      return outputPath;
    }

    await fs.rm(tempOutputPath, { force: true });
    try {
      await this.withProcessorSlot(() =>
        this.runFfmpeg(absolutePath, tempOutputPath, kind)
      );
      const stats = await fs.stat(tempOutputPath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new Error("Generated thumbnail is empty");
      }

      await fs.rm(outputPath, { force: true });
      await fs.rename(tempOutputPath, outputPath);
      const nextMeta: ThumbnailMeta = {
        sourcePath: relativePath,
        sourceModifiedMs,
        generatedAt: Date.now(),
      };
      await fs.writeFile(metaPath, JSON.stringify(nextMeta), "utf8");
      return outputPath;
    } catch (error) {
      await fs.rm(tempOutputPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withProcessorSlot<T>(task: () => Promise<T>) {
    await this.acquireProcessorSlot();
    try {
      return await task();
    } finally {
      this.releaseProcessorSlot();
    }
  }

  private async acquireProcessorSlot() {
    if (this.activeJobs < this.maxConcurrentJobs) {
      this.activeJobs += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.pending.push(() => {
        this.activeJobs += 1;
        resolve();
      });
    });
  }

  private releaseProcessorSlot() {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    const next = this.pending.shift();
    if (next) next();
  }

  private buildCacheKey(relativePath: string) {
    return crypto
      .createHash("sha1")
      .update(relativePath.replace(/\\/g, "/"))
      .digest("hex");
  }

  private async readMeta(metaPath: string) {
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw) as ThumbnailMeta;
      if (
        typeof parsed?.sourcePath === "string" &&
        typeof parsed.sourceModifiedMs === "number"
      ) {
        return parsed;
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      return null;
    }
  }

  private async fileExists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async runFfmpeg(
    inputPath: string,
    outputPath: string,
    kind: ThumbnailMediaKind
  ) {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "1",
      ...(kind === "video" || kind === "gif" ? ["-ss", "0.1"] : []),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2:force_original_aspect_ratio=decrease",
      "-q:v",
      "4",
      outputPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.ffmpegBin, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        reject(new Error(`Unable to execute ffmpeg (${this.ffmpegBin}): ${error.message}`));
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            stderr.trim() ||
              `Thumbnail generation failed with exit code ${code ?? "unknown"}`
          )
        );
      });
    });
  }
}
