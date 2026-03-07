import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { setImmediate as yieldToEventLoop } from "timers/promises";

interface StoredSnapshot<T> {
  version: number;
  key: string;
  stamp: string;
  createdAt: number;
  snapshot: T;
}

interface IndexStoreOptions {
  dir: string;
  maxBytes: number;
  version: number;
}

const SERIALIZE_FLUSH_THRESHOLD = 64 * 1024;
const SERIALIZE_YIELD_EVERY_CHUNKS = 256;

export class IndexStore {
  constructor(private readonly options: IndexStoreOptions) {}

  async readSnapshot<T>(key: string, expectedStamp?: string): Promise<T | null> {
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
    if (typeof expectedStamp === "string" && parsed.stamp !== expectedStamp) {
      return null;
    }

    return parsed.snapshot;
  }

  async writeSnapshot<T>(key: string, stamp: string, snapshot: T): Promise<void> {
    await this.ensureDir();
    const finalPath = this.filePathForKey(key);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    const payload: StoredSnapshot<T> = {
      version: this.options.version,
      key,
      stamp,
      createdAt: Date.now(),
      snapshot,
    };

    try {
      await writeSerializedJson(tempPath, payload);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
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

const normalizeJsonValue = (value: unknown, inArray: boolean): unknown | undefined => {
  if (
    value &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof (value as { toJSON?: () => unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return inArray ? null : undefined;
    case "object":
      return value;
    default:
      return null;
  }
};

function* serializeNormalizedJson(
  value: unknown,
  seen: WeakSet<object>
): Generator<string> {
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
    return;
  }

  if (seen.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ",";
        const normalizedItem = normalizeJsonValue(value[index], true);
        if (normalizedItem === undefined) {
          yield "null";
        } else {
          yield* serializeNormalizedJson(normalizedItem, seen);
        }
      }
      yield "]";
      return;
    }

    yield "{";
    let first = true;
    for (const [key, rawValue] of Object.entries(value)) {
      const normalizedValue = normalizeJsonValue(rawValue, false);
      if (normalizedValue === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key);
      yield ":";
      yield* serializeNormalizedJson(normalizedValue, seen);
    }
    yield "}";
  } finally {
    seen.delete(value);
  }
}

function* serializeJson(value: unknown): Generator<string> {
  const normalizedValue = normalizeJsonValue(value, false);
  if (normalizedValue === undefined) {
    throw new TypeError("Unable to serialize top-level JSON value");
  }
  yield* serializeNormalizedJson(normalizedValue, new WeakSet<object>());
}

const writeSerializedJson = async (filePath: string, value: unknown) => {
  const handle = await fs.open(filePath, "w");
  try {
    let buffer = "";
    let chunkCount = 0;

    for (const chunk of serializeJson(value)) {
      buffer += chunk;
      chunkCount += 1;

      if (buffer.length >= SERIALIZE_FLUSH_THRESHOLD) {
        await handle.write(buffer);
        buffer = "";
      }

      if (chunkCount % SERIALIZE_YIELD_EVERY_CHUNKS === 0) {
        if (buffer) {
          await handle.write(buffer);
          buffer = "";
        }
        await yieldToEventLoop();
      }
    }

    if (buffer) {
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
};
