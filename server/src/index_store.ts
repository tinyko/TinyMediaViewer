import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

interface StoredSnapshot<T> {
  version: number;
  key: string;
  mtimeMs: number;
  createdAt: number;
  snapshot: T;
}

interface IndexStoreOptions {
  dir: string;
  maxBytes: number;
  version: number;
}

export class IndexStore<T> {
  constructor(private readonly options: IndexStoreOptions) {}

  async readSnapshot(key: string, expectedMtimeMs?: number): Promise<T | null> {
    const filePath = this.filePathForKey(key);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let parsed: StoredSnapshot<T>;
    try {
      parsed = JSON.parse(content) as StoredSnapshot<T>;
    } catch {
      await this.invalidate(key);
      return null;
    }

    if (parsed.version !== this.options.version) {
      await this.invalidate(key);
      return null;
    }
    if (parsed.key !== key) {
      await this.invalidate(key);
      return null;
    }
    if (
      typeof expectedMtimeMs === "number" &&
      Number.isFinite(expectedMtimeMs) &&
      parsed.mtimeMs !== expectedMtimeMs
    ) {
      return null;
    }

    return parsed.snapshot;
  }

  async writeSnapshot(key: string, mtimeMs: number, snapshot: T): Promise<void> {
    await this.ensureDir();
    const finalPath = this.filePathForKey(key);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    const payload: StoredSnapshot<T> = {
      version: this.options.version,
      key,
      mtimeMs,
      createdAt: Date.now(),
      snapshot,
    };

    await fs.writeFile(tempPath, JSON.stringify(payload));
    await fs.rename(tempPath, finalPath);
    await this.enforceMaxBytes();
  }

  async invalidate(key: string): Promise<void> {
    const filePath = this.filePathForKey(key);
    await fs.rm(filePath, { force: true });
  }

  private async ensureDir() {
    await fs.mkdir(this.options.dir, { recursive: true });
  }

  private filePathForKey(key: string) {
    const hash = crypto.createHash("sha1").update(key).digest("hex");
    return path.join(this.options.dir, `${hash}.json`);
  }

  private async enforceMaxBytes() {
    if (this.options.maxBytes <= 0) return;
    let files: string[];
    try {
      files = (await fs.readdir(this.options.dir)).filter((name) =>
        name.endsWith(".json")
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    const fileStats = await Promise.all(
      files.map(async (name) => {
        const fullPath = path.join(this.options.dir, name);
        const stat = await fs.stat(fullPath);
        return {
          fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      })
    );

    fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = fileStats.reduce((sum, item) => sum + item.size, 0);

    for (const entry of fileStats) {
      if (total <= this.options.maxBytes) break;
      await fs.rm(entry.fullPath, { force: true });
      total -= entry.size;
    }
  }
}
