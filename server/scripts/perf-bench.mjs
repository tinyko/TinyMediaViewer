#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  pickFreePort,
  startBackend,
  stopBackend,
} from "./backend-runner.mjs";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(SERVER_DIR, "dist", "server.js");
const REPORT_DIR = path.join(SERVER_DIR, "perf-reports");
const TMP_DIR = path.join(SERVER_DIR, ".tmp");
const INDEX_DIR = path.join(TMP_DIR, "perf-index");
const SYNTHETIC_ROOT = path.join(TMP_DIR, "perf-synthetic-media-root");
const DEFAULT_MEDIA_ROOT = "/Users/tiny/X";
const HOST = "127.0.0.1";
const BACKEND = (process.env.PERF_BACKEND || "node").trim().toLowerCase();
const RUST_PROFILE = (process.env.PERF_RUST_PROFILE || "debug").trim().toLowerCase();
const ROOT_LIMIT = parseIntegerEnv("PERF_ROOT_LIMIT", 240, 1);
const HOT_LOOP = parseIntegerEnv("PERF_HOT_LOOP", 50, 1);
const S4_HOT_LOOP = parseIntegerEnv("PERF_S4_HOT_LOOP", 40, 1);
const COLD_CONCURRENT_REQUESTS = parseIntegerEnv("PERF_COLD_CONCURRENT", 4, 1);
const FIXTURE_MODE = (process.env.PERF_FIXTURE_MODE ?? "real").trim().toLowerCase();
const KEEP_SYNTHETIC_FIXTURE = parseBooleanEnv("PERF_KEEP_FIXTURE", false);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseIntegerEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
};

const nowStamp = () => {
  const date = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const mapWithConcurrency = async (items, concurrency, mapper) => {
  if (!items.length) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
};

const syntheticConfig = () => ({
  accountCount: parseIntegerEnv("SYNTHETIC_ACCOUNT_COUNT", 24, 1),
  hotFolderMultiplier: parseIntegerEnv("SYNTHETIC_HOT_FOLDER_MULTIPLIER", 3, 1),
  rootMediaCount: parseIntegerEnv("SYNTHETIC_ROOT_MEDIA_COUNT", 12, 0),
  directMediaPerAccount: parseIntegerEnv("SYNTHETIC_DIRECT_MEDIA_PER_ACCOUNT", 16, 0),
  imagesPerAccount: parseIntegerEnv("SYNTHETIC_IMAGES_PER_ACCOUNT", 120, 0),
  videosPerAccount: parseIntegerEnv("SYNTHETIC_VIDEOS_PER_ACCOUNT", 32, 0),
  gifsPerAccount: parseIntegerEnv("SYNTHETIC_GIFS_PER_ACCOUNT", 24, 0),
  nestedDirsPerAccount: parseIntegerEnv("SYNTHETIC_NESTED_DIRS_PER_ACCOUNT", 3, 0),
  nestedMediaPerDir: parseIntegerEnv("SYNTHETIC_NESTED_MEDIA_PER_DIR", 8, 0),
  imageBytes: parseIntegerEnv("SYNTHETIC_IMAGE_BYTES", 2048, 16),
  gifBytes: parseIntegerEnv("SYNTHETIC_GIF_BYTES", 4096, 16),
  videoBytes: parseIntegerEnv("SYNTHETIC_VIDEO_BYTES", 24576, 16),
  textBytes: parseIntegerEnv("SYNTHETIC_TEXT_BYTES", 512, 1),
});

const repeatBuffer = (size, char) => Buffer.alloc(size, char.charCodeAt(0));

const writeFixtureFile = async ({ filePath, sizeBytes, fill }) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, repeatBuffer(sizeBytes, fill));
};

const buildSyntheticFixtureJobs = (fixtureRoot, config) => {
  const jobs = [];
  let totalMediaFiles = 0;
  let ignoredNestedMediaFiles = 0;
  let nonMediaFiles = 0;

  const pushMedia = (filePath, sizeBytes, fill) => {
    jobs.push({ filePath, sizeBytes, fill });
    totalMediaFiles += 1;
  };

  const pushIgnored = (filePath, sizeBytes, fill) => {
    jobs.push({ filePath, sizeBytes, fill });
    ignoredNestedMediaFiles += 1;
  };

  const pushNonMedia = (filePath, sizeBytes, fill) => {
    jobs.push({ filePath, sizeBytes, fill });
    nonMediaFiles += 1;
  };

  for (let index = 0; index < config.rootMediaCount; index += 1) {
    const rootExt = index % 4 === 0 ? ".mp4" : index % 3 === 0 ? ".gif" : ".jpg";
    const sizeBytes =
      rootExt === ".mp4"
        ? config.videoBytes
        : rootExt === ".gif"
          ? config.gifBytes
          : config.imageBytes;
    pushMedia(
      path.join(fixtureRoot, `root-${String(index).padStart(4, "0")}${rootExt}`),
      sizeBytes,
      rootExt === ".mp4" ? "v" : rootExt === ".gif" ? "g" : "i"
    );
  }

  for (let accountIndex = 0; accountIndex < config.accountCount; accountIndex += 1) {
    const accountName =
      accountIndex === 0 ? "account-hot" : `account-${String(accountIndex).padStart(4, "0")}`;
    const accountRoot = path.join(fixtureRoot, accountName);
    const multiplier = accountIndex === 0 ? config.hotFolderMultiplier : 1;

    for (let mediaIndex = 0; mediaIndex < config.directMediaPerAccount * multiplier; mediaIndex += 1) {
      const ext = mediaIndex % 3 === 0 ? ".mp4" : mediaIndex % 2 === 0 ? ".gif" : ".jpg";
      const sizeBytes =
        ext === ".mp4" ? config.videoBytes : ext === ".gif" ? config.gifBytes : config.imageBytes;
      pushMedia(
        path.join(accountRoot, `direct-${String(mediaIndex).padStart(4, "0")}${ext}`),
        sizeBytes,
        ext === ".mp4" ? "v" : ext === ".gif" ? "g" : "i"
      );
    }

    for (let imageIndex = 0; imageIndex < config.imagesPerAccount * multiplier; imageIndex += 1) {
      pushMedia(
        path.join(
          accountRoot,
          "images",
          `image-${String(imageIndex).padStart(4, "0")}.jpg`
        ),
        config.imageBytes,
        "i"
      );
    }

    for (let videoIndex = 0; videoIndex < config.videosPerAccount * multiplier; videoIndex += 1) {
      pushMedia(
        path.join(
          accountRoot,
          "videos",
          `video-${String(videoIndex).padStart(4, "0")}.mp4`
        ),
        config.videoBytes,
        "v"
      );
    }

    for (let gifIndex = 0; gifIndex < config.gifsPerAccount * multiplier; gifIndex += 1) {
      pushMedia(
        path.join(accountRoot, "gifs", `gif-${String(gifIndex).padStart(4, "0")}.gif`),
        config.gifBytes,
        "g"
      );
    }

    for (let nestedDirIndex = 0; nestedDirIndex < config.nestedDirsPerAccount; nestedDirIndex += 1) {
      const nestedImagesDir = path.join(
        accountRoot,
        "images",
        `nested-${String(nestedDirIndex).padStart(2, "0")}`
      );
      const nestedVideosDir = path.join(
        accountRoot,
        "videos",
        `deep-${String(nestedDirIndex).padStart(2, "0")}`
      );

      for (let nestedIndex = 0; nestedIndex < config.nestedMediaPerDir; nestedIndex += 1) {
        pushIgnored(
          path.join(
            nestedImagesDir,
            `ignored-${String(nestedIndex).padStart(4, "0")}.jpg`
          ),
          config.imageBytes,
          "n"
        );
        pushIgnored(
          path.join(
            nestedVideosDir,
            `ignored-${String(nestedIndex).padStart(4, "0")}.mp4`
          ),
          config.videoBytes,
          "d"
        );
      }
    }

    pushNonMedia(path.join(accountRoot, "notes.txt"), config.textBytes, "t");
    pushNonMedia(path.join(accountRoot, ".hidden-cache"), config.textBytes, "h");
  }

  return {
    jobs,
    summary: {
      accountCount: config.accountCount,
      hotFolderMultiplier: config.hotFolderMultiplier,
      rootMediaCount: config.rootMediaCount,
      directMediaPerAccount: config.directMediaPerAccount,
      imagesPerAccount: config.imagesPerAccount,
      videosPerAccount: config.videosPerAccount,
      gifsPerAccount: config.gifsPerAccount,
      nestedDirsPerAccount: config.nestedDirsPerAccount,
      nestedMediaPerDir: config.nestedMediaPerDir,
      totalMediaFiles,
      ignoredNestedMediaFiles,
      nonMediaFiles,
    },
  };
};

const prepareFixture = async () => {
  if (FIXTURE_MODE === "real") {
    return {
      mediaRoot: path.resolve(process.env.MEDIA_ROOT ?? DEFAULT_MEDIA_ROOT),
      fixture: {
        mode: "real",
      },
      cleanup: async () => undefined,
    };
  }

  if (FIXTURE_MODE !== "synthetic") {
    throw new Error(
      `Unsupported PERF_FIXTURE_MODE=${FIXTURE_MODE}. Expected "real" or "synthetic".`
    );
  }

  const config = syntheticConfig();
  await fs.rm(SYNTHETIC_ROOT, { recursive: true, force: true });
  await fs.mkdir(SYNTHETIC_ROOT, { recursive: true });

  const { jobs, summary } = buildSyntheticFixtureJobs(SYNTHETIC_ROOT, config);
  await mapWithConcurrency(jobs, 32, (job) => writeFixtureFile(job));

  return {
    mediaRoot: SYNTHETIC_ROOT,
    fixture: {
      mode: "synthetic",
      keepFixture: KEEP_SYNTHETIC_FIXTURE,
      synthetic: summary,
    },
    cleanup: async () => {
      if (!KEEP_SYNTHETIC_FIXTURE) {
        await fs.rm(SYNTHETIC_ROOT, { recursive: true, force: true });
      }
    },
  };
};

const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });

const getLatestIndexWriteMs = async () => {
  try {
    const files = (await fs.readdir(INDEX_DIR)).filter(
      (name) =>
        name.endsWith(".json") ||
        name.endsWith(".sqlite3") ||
        name.endsWith(".sqlite3-wal") ||
        name.endsWith(".sqlite3-shm")
    );
    if (!files.length) {
      return 0;
    }
    const stats = await mapWithConcurrency(files, 16, async (name) => {
      const fullPath = path.join(INDEX_DIR, name);
      const stat = await fs.stat(fullPath);
      return stat.mtimeMs;
    });
    return Math.max(0, ...stats);
  } catch {
    return 0;
  }
};

const waitForIndexWritesToSettle = async (
  sinceMs,
  timeoutMs = 10_000,
  quietWindowMs = 250
) => {
  const started = Date.now();
  let latestSeenWrite = 0;
  let quietSince = 0;
  let sawPersistedArtifact = false;

  while (Date.now() - started < timeoutMs) {
    const latestWrite = await getLatestIndexWriteMs();
    if (latestWrite > 0) {
      sawPersistedArtifact = true;
    }
    if (latestWrite > latestSeenWrite) {
      latestSeenWrite = latestWrite;
      quietSince = Date.now();
    }
    if (latestWrite >= sinceMs) {
      if (quietSince && Date.now() - quietSince >= quietWindowMs) {
        return;
      }
    } else if (
      sawPersistedArtifact &&
      quietSince &&
      Date.now() - quietSince >= quietWindowMs &&
      Date.now() - started >= 1_000
    ) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Index writes did not settle within ${timeoutMs}ms`);
};

const getRssBytes = async (pid) => {
  if (!pid) return 0;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    if (!Number.isFinite(kb) || kb <= 0) return 0;
    return kb * 1024;
  } catch {
    return 0;
  }
};

const timed = async (task) => {
  const started = performance.now();
  const value = await task();
  return { durationMs: performance.now() - started, value };
};

const encodeMediaPath = (relativePath) =>
  relativePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

const requestJson = async (baseUrl, pathname, init = undefined) => {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    json,
  };
};

const getFolder = (baseUrl, folderPath, mode, limit = ROOT_LIMIT, cursor = undefined) => {
  const params = new URLSearchParams();
  if (folderPath) params.set("path", folderPath);
  if (mode) params.set("mode", mode);
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return requestJson(baseUrl, `/api/folder?${params.toString()}`);
};

const postPreviews = (baseUrl, paths, limitPerFolder = 3) =>
  requestJson(baseUrl, "/api/folder/previews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      paths,
      limitPerFolder,
    }),
  });

const findLargestFolder = async (baseUrl, previewBatchLimit = 64) => {
  const root = await getFolder(baseUrl, "", "light", ROOT_LIMIT);
  if (root.status !== 200 || !root.json?.subfolders?.length) {
    return {
      path: "",
      estimatedMedia: 0,
    };
  }

  const candidates = root.json.subfolders.map((item) => item.path).filter(Boolean);
  const items = [];
  for (let i = 0; i < candidates.length; i += previewBatchLimit) {
    const chunk = candidates.slice(i, i + previewBatchLimit);
    const response = await postPreviews(baseUrl, chunk, 1);
    if (response.status !== 200 || !Array.isArray(response.json?.items)) continue;
    items.push(...response.json.items);
  }

  if (!items.length) {
    return {
      path: candidates[0] ?? "",
      estimatedMedia: 0,
    };
  }

  const sorted = items
    .map((item) => ({
      path: item.path,
      estimatedMedia: item.counts.images + item.counts.gifs + item.counts.videos,
    }))
    .sort((a, b) => b.estimatedMedia - a.estimatedMedia);

  return sorted[0];
};

const findSampleMediaPath = async (baseUrl, preferredPath) => {
  if (preferredPath) {
    const preferred = await getFolder(baseUrl, preferredPath, "full", ROOT_LIMIT);
    if (preferred.status === 200 && preferred.json?.media?.length) {
      return preferred.json.media[0].path;
    }
  }

  const root = await getFolder(baseUrl, "", "light", ROOT_LIMIT);
  const fallbackPaths = root.json?.subfolders?.map((item) => item.path) ?? [];
  for (const folderPath of fallbackPaths) {
    const response = await getFolder(baseUrl, folderPath, "full", ROOT_LIMIT);
    if (response.status === 200 && response.json?.media?.length) {
      return response.json.media[0].path;
    }
  }

  return null;
};

const run = async () => {
  const previewBatchLimit = Number(process.env.PREVIEW_BATCH_LIMIT ?? 64);
  const rssSamples = {
    s1: 0,
    s2: 0,
    s4: 0,
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.rm(INDEX_DIR, { recursive: true, force: true });

  const fixture = await prepareFixture();
  const mediaRoot = fixture.mediaRoot;
  const port = Number(process.env.PERF_PORT ?? (await pickFreePort()));
  let server = null;

  const scenario = {
    s1: {
      coldSingleMs: 0,
      status: 0,
      persistedRestartMs: 0,
      persistedStatus: 0,
    },
    s2: {
      coldConcurrentMs: [],
      p95Ms: 0,
      statuses: [],
    },
    s3: {
      hotSerialMs: [],
      p95Ms: 0,
    },
    s4: {
      targetPath: "",
      estimatedMedia: 0,
      coldMs: 0,
      coldStatus: 0,
      persistedRestartMs: 0,
      persistedStatus: 0,
      hotMs: [],
      hotP95Ms: 0,
    },
    s5: {
      mediaPath: null,
      fullDownload: {
        status: 0,
        durationMs: 0,
      },
      rangeRequest: {
        status: 0,
        durationMs: 0,
        contentRange: "",
      },
    },
    s6: {
      rssSamplesBytes: rssSamples,
      peakRssBytes: 0,
    },
  };

  try {
    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    const s1PersistStart = Date.now();
    const s1 = await timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT));
    scenario.s1.coldSingleMs = Number(s1.durationMs.toFixed(2));
    scenario.s1.status = s1.value.status;
    rssSamples.s1 = await getRssBytes(server.child.pid);
    await waitForIndexWritesToSettle(s1PersistStart);
    await stopBackend(server.child);
    server = null;

    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    const s1Persisted = await timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT));
    scenario.s1.persistedRestartMs = Number(s1Persisted.durationMs.toFixed(2));
    scenario.s1.persistedStatus = s1Persisted.value.status;
    await stopBackend(server.child);
    server = null;
    await fs.rm(INDEX_DIR, { recursive: true, force: true });

    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    const s2Runs = await Promise.all(
      Array.from({ length: COLD_CONCURRENT_REQUESTS }).map(() =>
        timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT))
      )
    );
    scenario.s2.coldConcurrentMs = s2Runs.map((run) => Number(run.durationMs.toFixed(2)));
    scenario.s2.statuses = s2Runs.map((run) => run.value.status);
    scenario.s2.p95Ms = Number(percentile(scenario.s2.coldConcurrentMs, 0.95).toFixed(2));
    rssSamples.s2 = await getRssBytes(server.child.pid);
    await stopBackend(server.child);
    server = null;

    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    await getFolder(server.baseUrl, "", "light", ROOT_LIMIT);
    for (let i = 0; i < HOT_LOOP; i += 1) {
      const timedRun = await timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT));
      scenario.s3.hotSerialMs.push(Number(timedRun.durationMs.toFixed(2)));
    }
    scenario.s3.p95Ms = Number(percentile(scenario.s3.hotSerialMs, 0.95).toFixed(2));
    await stopBackend(server.child);
    server = null;

    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    const target = await findLargestFolder(server.baseUrl, previewBatchLimit);
    scenario.s4.targetPath = target.path;
    scenario.s4.estimatedMedia = target.estimatedMedia;

    const s4PersistStart = Date.now();
    const s4Cold = await timed(() =>
      getFolder(server.baseUrl, target.path, "full", ROOT_LIMIT)
    );
    scenario.s4.coldMs = Number(s4Cold.durationMs.toFixed(2));
    scenario.s4.coldStatus = s4Cold.value.status;
    await waitForIndexWritesToSettle(s4PersistStart);
    await stopBackend(server.child);
    server = null;

    server = await startBackend({
      backend: BACKEND,
      mediaRoot,
      port,
      host: HOST,
      indexDir: INDEX_DIR,
      thumbnailDir: path.join(TMP_DIR, `perf-thumbnails-${BACKEND}`),
      diagnosticsDir: path.join(TMP_DIR, `perf-diagnostics-${BACKEND}`),
      rustProfile: RUST_PROFILE,
    });
    const s4Persisted = await timed(() =>
      getFolder(server.baseUrl, target.path, "full", ROOT_LIMIT)
    );
    scenario.s4.persistedRestartMs = Number(s4Persisted.durationMs.toFixed(2));
    scenario.s4.persistedStatus = s4Persisted.value.status;

    for (let i = 0; i < S4_HOT_LOOP; i += 1) {
      const timedRun = await timed(() =>
        getFolder(server.baseUrl, target.path, "full", ROOT_LIMIT)
      );
      scenario.s4.hotMs.push(Number(timedRun.durationMs.toFixed(2)));
    }
    scenario.s4.hotP95Ms = Number(percentile(scenario.s4.hotMs, 0.95).toFixed(2));
    rssSamples.s4 = await getRssBytes(server.child.pid);

    const mediaPath = await findSampleMediaPath(server.baseUrl, target.path);
    scenario.s5.mediaPath = mediaPath;
    if (mediaPath) {
      const encoded = encodeMediaPath(mediaPath);
      const full = await timed(() => requestJson(server.baseUrl, `/media/${encoded}`));
      scenario.s5.fullDownload.status = full.value.status;
      scenario.s5.fullDownload.durationMs = Number(full.durationMs.toFixed(2));

      const range = await timed(() =>
        requestJson(server.baseUrl, `/media/${encoded}`, {
          headers: {
            Range: "bytes=0-1023",
          },
        })
      );
      scenario.s5.rangeRequest.status = range.value.status;
      scenario.s5.rangeRequest.durationMs = Number(range.durationMs.toFixed(2));
      scenario.s5.rangeRequest.contentRange =
        range.value.headers.get("content-range") ?? "";
    }

    scenario.s6.peakRssBytes = Math.max(rssSamples.s1, rssSamples.s2, rssSamples.s4);
  } finally {
    if (server?.child) {
      await stopBackend(server.child);
    }
    await fixture.cleanup();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    backend: BACKEND,
    backendProfile: BACKEND === "rust" ? RUST_PROFILE : "js",
    mediaRoot,
    fixture: fixture.fixture,
    host: HOST,
    port,
    scenarios: scenario,
  };

  const reportPath = path.join(REPORT_DIR, `${nowStamp()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Performance report written: ${reportPath}`);
  console.log(
    JSON.stringify(
      {
        fixtureMode: report.fixture.mode,
        s1Ms: report.scenarios.s1.coldSingleMs,
        s1PersistedMs: report.scenarios.s1.persistedRestartMs,
        s2P95Ms: report.scenarios.s2.p95Ms,
        s3P95Ms: report.scenarios.s3.p95Ms,
        s4ColdMs: report.scenarios.s4.coldMs,
        s4PersistedMs: report.scenarios.s4.persistedRestartMs,
        s4HotP95Ms: report.scenarios.s4.hotP95Ms,
        s6PeakRssMB: Number((report.scenarios.s6.peakRssBytes / 1024 / 1024).toFixed(2)),
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
