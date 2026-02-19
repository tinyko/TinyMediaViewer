import crypto from "crypto";
import os from "os";
import path from "path";

const defaultRoot = path.resolve(process.cwd(), "..", "..");
const defaultOrigins = ["http://localhost", "http://127.0.0.1", "http://[::1]"];

const asNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const asBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const normalizeOrigin = (value: string) => value.trim().replace(/\/+$/, "");

const parseOrigins = (value?: string) => {
  if (!value) return [...defaultOrigins];
  const items = value
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter(Boolean);
  return items.length ? Array.from(new Set(items)) : [...defaultOrigins];
};

const randomToken = () => crypto.randomBytes(18).toString("hex");
const expandHomePath = (value: string) =>
  value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

export interface AppConfig {
  mediaRoot: string;
  port: number;
  host: string;
  previewLimit: number;
  previewBatchLimit: number;
  maxItemsPerFolder: number;
  folderPageLimit: number;
  maxFolderPageLimit: number;
  statConcurrency: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  cacheMaxBytes: number;
  enableLightRootMode: boolean;
  enableIndexPersist: boolean;
  indexDir: string;
  indexMaxBytes: number;
  requireLanToken: boolean;
  mediaAccessToken: string;
  corsAllowedOrigins: string[];
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  return {
    mediaRoot: path.resolve(env.MEDIA_ROOT ?? defaultRoot),
    port: asNumber(env.PORT, 4000),
    host: env.SERVER_HOST ?? "0.0.0.0",
    previewLimit: asNumber(env.PREVIEW_LIMIT, 6),
    previewBatchLimit: asNumber(env.PREVIEW_BATCH_LIMIT, 64),
    maxItemsPerFolder: asNumber(env.MAX_ITEMS_PER_FOLDER, 20000),
    folderPageLimit: asNumber(env.FOLDER_PAGE_LIMIT, 240),
    maxFolderPageLimit: asNumber(env.MAX_FOLDER_PAGE_LIMIT, 1000),
    statConcurrency: asNumber(env.STAT_CONCURRENCY, 24),
    cacheTtlMs: asNumber(env.CACHE_TTL_MS, 60000),
    cacheMaxEntries: asNumber(env.CACHE_MAX_ENTRIES, 256),
    cacheMaxBytes: asNumber(env.CACHE_MAX_BYTES, 200 * 1024 * 1024),
    enableLightRootMode: asBoolean(env.ENABLE_LIGHT_ROOT_MODE, true),
    enableIndexPersist: asBoolean(env.ENABLE_INDEX_PERSIST, true),
    indexDir: path.resolve(
      expandHomePath(
        env.INDEX_DIR ??
          path.join(
            os.homedir(),
            "Library",
            "Application Support",
            "TinyMediaViewer",
            "index"
          )
      )
    ),
    indexMaxBytes: asNumber(env.INDEX_MAX_BYTES, 1024 * 1024 * 1024),
    requireLanToken: asBoolean(env.REQUIRE_LAN_TOKEN, true),
    mediaAccessToken: env.MEDIA_ACCESS_TOKEN?.trim() || randomToken(),
    corsAllowedOrigins: parseOrigins(env.CORS_ALLOWED_ORIGINS),
  };
};

export const isOriginAllowed = (origin: string | undefined, appConfig: AppConfig) => {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    return true;
  }

  const normalized = normalizeOrigin(parsed.origin);
  if (appConfig.corsAllowedOrigins.includes("*")) {
    return true;
  }

  return appConfig.corsAllowedOrigins
    .map((item) => normalizeOrigin(item))
    .includes(normalized);
};

export const config = loadConfig();
