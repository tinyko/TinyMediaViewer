import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "node:url";
import { pickFreePort, startBackend, stopBackend } from "./backend-runner.mjs";

const CATEGORY_DIRS = new Set([
  "image",
  "images",
  "video",
  "videos",
  "gif",
  "gifs",
  "media",
  "medias",
]);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"]);
const DEFAULT_BASE_URL = process.env.TMV_AUDIT_BASE_URL || "http://127.0.0.1:4000";
const DEFAULT_BACKEND = (process.env.TMV_AUDIT_BACKEND || "").trim().toLowerCase();
const DEFAULT_PAGE_LIMIT = Number.parseInt(process.env.TMV_AUDIT_PAGE_LIMIT || "120", 10);
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.TMV_AUDIT_CONCURRENCY || "4", 10);
const REPORT_DIR = path.resolve(
  process.cwd(),
  process.env.TMV_AUDIT_REPORT_DIR || "audit-reports"
);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_DIR = path.join(path.resolve(__dirname, ".."), ".tmp");

const parseArgs = (argv) => {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") parsed.baseUrl = argv[++index];
    else if (arg === "--backend") parsed.backend = argv[++index];
    else if (arg === "--media-root") parsed.mediaRoot = argv[++index];
    else if (arg === "--page-limit") parsed.pageLimit = Number.parseInt(argv[++index], 10);
    else if (arg === "--concurrency") {
      parsed.concurrency = Number.parseInt(argv[++index], 10);
    }
  }
  return parsed;
};

const args = parseArgs(process.argv.slice(2));
const backend = (args.backend || DEFAULT_BACKEND).trim().toLowerCase();
const rawMediaRoot =
  args.mediaRoot || process.env.TMV_AUDIT_MEDIA_ROOT || process.env.MEDIA_ROOT || "";
const mediaRoot = rawMediaRoot ? path.resolve(rawMediaRoot) : "";
const pageLimit = Number.isFinite(args.pageLimit) ? args.pageLimit : DEFAULT_PAGE_LIMIT;
const concurrency = Number.isFinite(args.concurrency)
  ? args.concurrency
  : DEFAULT_CONCURRENCY;
let baseUrl = args.baseUrl || process.env.TMV_AUDIT_BASE_URL || "";
let backendHandle = null;

if (!mediaRoot) {
  throw new Error(
    "Missing media root. Pass --media-root <path> or set TMV_AUDIT_MEDIA_ROOT / MEDIA_ROOT."
  );
}

const rootRealPath = await fs.realpath(mediaRoot);

if (!baseUrl) {
  if (!backend || !["node", "rust"].includes(backend)) {
    baseUrl = DEFAULT_BASE_URL;
  } else {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const port = await pickFreePort();
    const indexDir = path.join(TMP_DIR, `audit-index-${backend}`);
    const thumbnailDir = path.join(TMP_DIR, `audit-thumbnails-${backend}`);
    const diagnosticsDir = path.join(TMP_DIR, `audit-diagnostics-${backend}`);
    await fs.rm(indexDir, { recursive: true, force: true });
    await fs.rm(thumbnailDir, { recursive: true, force: true });
    await fs.rm(diagnosticsDir, { recursive: true, force: true });
    backendHandle = await startBackend({
      backend,
      mediaRoot,
      port,
      indexDir,
      thumbnailDir,
      diagnosticsDir,
    });
    baseUrl = backendHandle.baseUrl;
  }
}

const detectMediaKind = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".gif") return "gif";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
};

const isHidden = (name) => name.startsWith(".");

const toPosix = (value) => value.replace(/\\/g, "/");

const isInsideRoot = (absolutePath) => {
  const relative = path.relative(rootRealPath, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const countFilterTotal = (counts, filter) =>
  filter === "image" ? counts.images + counts.gifs : counts.videos;

const countPageFilterTotal = (media, filter) =>
  media.filter((item) =>
    filter === "image" ? item.kind === "image" || item.kind === "gif" : item.kind === "video"
  ).length;

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const withConcurrency = async (items, limit, task) => {
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await task(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
};

const fetchJson = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error =
      typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(`${url} -> ${error}`);
  }
  return response.json();
};

const fetchRootLight = async () => {
  const params = new URLSearchParams({
    mode: "light",
    limit: String(pageLimit),
  });
  return fetchJson(`${baseUrl}/api/folder?${params.toString()}`);
};

const fetchPreviewBatch = async (paths) =>
  fetchJson(`${baseUrl}/api/folder/previews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths,
      limitPerFolder: 6,
    }),
  });

const fetchFirstFullPage = async (accountPath, filter) => {
  const params = new URLSearchParams({
    path: accountPath,
    mode: "full",
    limit: String(pageLimit),
  });
  if (filter) {
    params.set("kind", filter);
  }
  return fetchJson(`${baseUrl}/api/folder?${params.toString()}`);
};

const fetchFullPage = async (accountPath, cursor, filter) => {
  const params = new URLSearchParams({
    path: accountPath,
    mode: "full",
    limit: String(pageLimit),
    cursor,
  });
  if (filter) {
    params.set("kind", filter);
  }
  return fetchJson(`${baseUrl}/api/folder?${params.toString()}`);
};

const resolveSymlinkTarget = async (entryAbsolute) => {
  try {
    const realPath = await fs.realpath(entryAbsolute);
    if (!isInsideRoot(realPath)) return null;
    const stats = await fs.stat(realPath);
    return {
      absolutePath: realPath,
      stats,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const accumulateMediaCounts = async (directoryPath, counts) => {
  const directory = await fs.opendir(directoryPath);
  for await (const entry of directory) {
    if (isHidden(entry.name)) continue;
    const entryAbsolute = path.join(directoryPath, entry.name);

    if (entry.isFile()) {
      const kind = detectMediaKind(entryAbsolute);
      if (kind === "image") counts.images += 1;
      else if (kind === "gif") counts.gifs += 1;
      else if (kind === "video") counts.videos += 1;
      continue;
    }

    if (!entry.isSymbolicLink()) continue;
    const resolved = await resolveSymlinkTarget(entryAbsolute);
    if (!resolved || !resolved.stats.isFile()) continue;
    const kind = detectMediaKind(resolved.absolutePath);
    if (kind === "image") counts.images += 1;
    else if (kind === "gif") counts.gifs += 1;
    else if (kind === "video") counts.videos += 1;
  }
};

const scanAccountCounts = async (accountPath) => {
  const counts = { images: 0, gifs: 0, videos: 0 };
  const absolutePath = path.join(mediaRoot, accountPath);
  const directory = await fs.opendir(absolutePath);

  for await (const entry of directory) {
    if (isHidden(entry.name)) continue;
    const entryAbsolute = path.join(absolutePath, entry.name);
    const isCategoryDir = CATEGORY_DIRS.has(entry.name.toLowerCase());

    if (entry.isDirectory()) {
      if (isCategoryDir) {
        await accumulateMediaCounts(entryAbsolute, counts);
      }
      continue;
    }

    if (entry.isFile()) {
      const kind = detectMediaKind(entryAbsolute);
      if (kind === "image") counts.images += 1;
      else if (kind === "gif") counts.gifs += 1;
      else if (kind === "video") counts.videos += 1;
      continue;
    }

    if (!entry.isSymbolicLink()) continue;
    const resolved = await resolveSymlinkTarget(entryAbsolute);
    if (!resolved) continue;

    if (resolved.stats.isDirectory()) {
      if (isCategoryDir) {
        await accumulateMediaCounts(resolved.absolutePath, counts);
      }
      continue;
    }

    if (!resolved.stats.isFile()) continue;
    const kind = detectMediaKind(resolved.absolutePath);
    if (kind === "image") counts.images += 1;
    else if (kind === "gif") counts.gifs += 1;
    else if (kind === "video") counts.videos += 1;
  }

  return counts;
};

const resolveFilterMatchAcrossPages = async (accountPath, filter, firstPage) => {
  let pagesFetched = 1;
  if (countPageFilterTotal(firstPage.media, filter) > 0) {
    return { found: true, pagesFetched };
  }

  let cursor = firstPage.nextCursor ?? null;
  while (cursor) {
    const page = await fetchFullPage(accountPath, cursor, filter);
    pagesFetched += 1;
    if (countPageFilterTotal(page.media, filter) > 0) {
      return { found: true, pagesFetched };
    }
    cursor = page.nextCursor ?? null;
  }

  return { found: false, pagesFetched };
};

try {
  const root = await fetchRootLight();
  const rootPaths = root.subfolders.map((item) => item.path);
  const previewChunks = chunk(rootPaths, 64);
  const previewMap = new Map();
  const previewErrors = [];

  for (const paths of previewChunks) {
    const batch = await fetchPreviewBatch(paths);
    for (const item of batch.items ?? []) {
      previewMap.set(item.path, item);
    }
    for (const error of batch.errors ?? []) {
      previewErrors.push(error);
    }
  }

  const findings = await withConcurrency(rootPaths, concurrency, async (accountPath, index) => {
    const diskCounts = await scanAccountCounts(accountPath);
    const preview = previewMap.get(accountPath);

    const previewCounts = preview?.counts ?? { images: 0, gifs: 0, videos: 0, subfolders: 0 };
    const imageMismatch =
      previewCounts.images !== diskCounts.images || previewCounts.gifs !== diskCounts.gifs;
    const videoMismatch = previewCounts.videos !== diskCounts.videos;

    const requiresAdditionalPages = [];
    const staleNonZeroFilters = [];
    const emptyAfterExhaustivePaging = [];

    for (const filter of ["image", "video"]) {
      const diskTotal = countFilterTotal(diskCounts, filter);
      const previewTotal = countFilterTotal(previewCounts, filter);
      const firstFullPage =
        diskTotal > 0 ? await fetchFirstFullPage(accountPath, filter) : null;
      const firstPageTotal = firstFullPage ? countPageFilterTotal(firstFullPage.media, filter) : 0;

      if (previewTotal > 0 && diskTotal === 0) {
        staleNonZeroFilters.push(filter);
      }

      if (diskTotal > 0 && firstPageTotal === 0) {
        const resolution = await resolveFilterMatchAcrossPages(accountPath, filter, firstFullPage);
        requiresAdditionalPages.push({
          filter,
          diskTotal,
          previewTotal,
          nextCursor: firstFullPage?.nextCursor ?? null,
          pagesFetched: resolution.pagesFetched,
          resolvedByPaging: resolution.found,
        });
        if (!resolution.found) {
          emptyAfterExhaustivePaging.push(filter);
        }
      }
    }

    if ((index + 1) % 25 === 0 || index === rootPaths.length - 1) {
      console.log(`audited ${index + 1}/${rootPaths.length}: ${accountPath}`);
    }

    return {
      accountPath,
      diskCounts,
      previewCounts,
      imageMismatch,
      videoMismatch,
      staleNonZeroFilters,
      requiresAdditionalPages,
      emptyAfterExhaustivePaging,
    };
  });

  const mismatchedCounts = findings.filter((item) => item.imageMismatch || item.videoMismatch);
  const staleNonZeroAccounts = findings.filter((item) => item.staleNonZeroFilters.length > 0);
  const requiresAdditionalPages = findings
    .filter((item) => item.requiresAdditionalPages.length > 0)
    .map((item) => ({
      accountPath: item.accountPath,
      requiresAdditionalPages: item.requiresAdditionalPages,
    }));
  const emptyAfterExhaustivePaging = findings
    .filter((item) => item.emptyAfterExhaustivePaging.length > 0)
    .map((item) => ({
      accountPath: item.accountPath,
      emptyAfterExhaustivePaging: item.emptyAfterExhaustivePaging,
    }));

  const summary = {
    generatedAt: new Date().toISOString(),
    backend: backend || "external",
    baseUrl,
    mediaRoot: toPosix(mediaRoot),
    accountsScanned: rootPaths.length,
    previewBatchErrors: previewErrors,
    accountsWithImage: findings.filter((item) => countFilterTotal(item.diskCounts, "image") > 0)
      .length,
    accountsWithVideo: findings.filter((item) => countFilterTotal(item.diskCounts, "video") > 0)
      .length,
    mismatchedCounts,
    staleNonZeroAccounts,
    requiresAdditionalPages,
    emptyAfterExhaustivePaging,
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const reportName = `${summary.generatedAt.replace(/[:.]/g, "-")}.json`;
  const reportPath = path.join(REPORT_DIR, reportName);
  await fs.writeFile(reportPath, JSON.stringify(summary, null, 2));

  console.log(
    JSON.stringify(
      {
        generatedAt: summary.generatedAt,
        backend: summary.backend,
        baseUrl,
        accountsScanned: summary.accountsScanned,
        previewBatchErrors: summary.previewBatchErrors.length,
        mismatchedCounts: summary.mismatchedCounts.length,
        staleNonZeroAccounts: summary.staleNonZeroAccounts.length,
        requiresAdditionalPages: summary.requiresAdditionalPages.length,
        emptyAfterExhaustivePaging: summary.emptyAfterExhaustivePaging.length,
        reportPath,
      },
      null,
      2
    )
  );

  if (
    summary.mismatchedCounts.length ||
    summary.staleNonZeroAccounts.length ||
    summary.emptyAfterExhaustivePaging.length
  ) {
    process.exitCode = 1;
  }
} finally {
  if (backendHandle) {
    await stopBackend(backendHandle.child);
  }
}
