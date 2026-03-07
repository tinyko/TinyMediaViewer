#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickFreePort, startBackend, stopBackend } from "./backend-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(SERVER_DIR, "perf-reports");
const PROFILE_DIR = path.join(REPORT_DIR, "profiles");
const ROOT_LIMIT = 240;

const nowStamp = () => {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mediaRoot: process.env.MEDIA_ROOT ?? "/Users/tiny/X",
    targetPath: "",
    iterations: Number(process.env.PERSISTED_PROFILE_ITERATIONS ?? 3),
    sampleSeconds: Number(process.env.PERSISTED_PROFILE_SAMPLE_SECONDS ?? 2),
    rustProfile: process.env.PERSISTED_PROFILE_RUST_PROFILE ?? "release",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--media-root") {
      options.mediaRoot = args[index + 1] ?? options.mediaRoot;
      index += 1;
    } else if (arg === "--path") {
      options.targetPath = args[index + 1] ?? options.targetPath;
      index += 1;
    } else if (arg === "--iterations") {
      options.iterations = Number(args[index + 1] ?? options.iterations);
      index += 1;
    } else if (arg === "--sample-seconds") {
      options.sampleSeconds = Number(args[index + 1] ?? options.sampleSeconds);
      index += 1;
    } else if (arg === "--rust-profile") {
      options.rustProfile = args[index + 1] ?? options.rustProfile;
      index += 1;
    }
  }

  options.iterations =
    Number.isFinite(options.iterations) && options.iterations > 0
      ? Math.floor(options.iterations)
      : 3;
  options.sampleSeconds =
    Number.isFinite(options.sampleSeconds) && options.sampleSeconds > 0
      ? Math.floor(options.sampleSeconds)
      : 2;

  return options;
};

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
    bodyText: text,
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

const postPreviews = (baseUrl, paths, limitPerFolder = 1) =>
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
    return { path: "", estimatedMedia: 0 };
  }

  const candidates = root.json.subfolders.map((item) => item.path).filter(Boolean);
  const items = [];
  for (let index = 0; index < candidates.length; index += previewBatchLimit) {
    const chunk = candidates.slice(index, index + previewBatchLimit);
    const response = await postPreviews(baseUrl, chunk, 1);
    if (response.status !== 200 || !Array.isArray(response.json?.items)) {
      continue;
    }
    items.push(...response.json.items);
  }

  if (!items.length) {
    return { path: candidates[0] ?? "", estimatedMedia: 0 };
  }

  return items
    .map((item) => ({
      path: item.path,
      estimatedMedia: item.counts.images + item.counts.gifs + item.counts.videos,
    }))
    .sort((left, right) => right.estimatedMedia - left.estimatedMedia)[0];
};

const latestIndexWriteMs = async (indexDir) => {
  try {
    const names = await fs.readdir(indexDir);
    const candidates = names.filter((name) => name.startsWith("tmv-index.sqlite3"));
    if (!candidates.length) return 0;
    const stats = await Promise.all(
      candidates.map(async (name) => fs.stat(path.join(indexDir, name)))
    );
    return Math.max(...stats.map((stat) => stat.mtimeMs));
  } catch {
    return 0;
  }
};

const waitForIndexWritesToSettle = async (
  indexDir,
  sinceMs,
  timeoutMs = 10_000,
  quietWindowMs = 250
) => {
  const started = Date.now();
  let latestSeenWrite = 0;
  let quietSince = 0;

  while (Date.now() - started < timeoutMs) {
    const latestWrite = await latestIndexWriteMs(indexDir);
    if (latestWrite >= sinceMs) {
      if (latestWrite > latestSeenWrite) {
        latestSeenWrite = latestWrite;
        quietSince = Date.now();
      } else if (quietSince && Date.now() - quietSince >= quietWindowMs) {
        return;
      }
    }
    await sleep(100);
  }

  throw new Error(`Index writes did not settle within ${timeoutMs}ms`);
};

const timed = async (task) => {
  const started = performance.now();
  const value = await task();
  return {
    durationMs: performance.now() - started,
    value,
  };
};

const summarizeTimings = (values) => {
  if (!values.length) {
    return {
      count: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));

  return {
    count: sorted.length,
    meanMs: Number(meanMs.toFixed(2)),
    medianMs: Number(medianMs.toFixed(2)),
    p95Ms: Number(sorted[p95Index].toFixed(2)),
  };
};

const runSample = (pid, seconds, outputPath) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sample", [String(pid), String(seconds), "-file", outputPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `sample exited with code ${code}`));
    });
  });

const run = async () => {
  const options = parseArgs();
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-rust-persisted-profile-"));
  const indexDir = path.join(tempRoot, "index");
  const thumbnailDir = path.join(tempRoot, "thumbs");
  const diagnosticsDir = path.join(tempRoot, "diag");
  await fs.mkdir(indexDir, { recursive: true });
  await fs.mkdir(thumbnailDir, { recursive: true });
  await fs.mkdir(diagnosticsDir, { recursive: true });

  const iterations = [];
  let targetPath = options.targetPath;
  let estimatedMedia = 0;

  try {
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const port = await pickFreePort();
      let server = null;

      try {
        server = await startBackend({
          backend: "rust",
          mediaRoot: options.mediaRoot,
          port,
          indexDir,
          thumbnailDir,
          diagnosticsDir,
          rustProfile: options.rustProfile,
        });

        if (!targetPath) {
          const target = await findLargestFolder(server.baseUrl);
          targetPath = target.path;
          estimatedMedia = target.estimatedMedia;
        }

        if (!targetPath) {
          throw new Error("Unable to resolve persisted profiling target path");
        }

        const persistStartedAt = Date.now();
        const cold = await timed(() => getFolder(server.baseUrl, targetPath, "full", ROOT_LIMIT));
        if (cold.value.status !== 200) {
          throw new Error(
            `Cold full request failed with status ${cold.value.status}: ${cold.value.bodyText}`
          );
        }

        await waitForIndexWritesToSettle(indexDir, persistStartedAt);
        await stopBackend(server.child);
        server = null;

        server = await startBackend({
          backend: "rust",
          mediaRoot: options.mediaRoot,
          port,
          indexDir,
          thumbnailDir,
          diagnosticsDir,
          rustProfile: options.rustProfile,
        });

        const samplePath = path.join(
          PROFILE_DIR,
          `${nowStamp()}-rust-persisted-iter${String(iteration).padStart(2, "0")}.txt`
        );
        const sampleWindowStartedAt = performance.now();
        const sampleWindowDeadline = sampleWindowStartedAt + options.sampleSeconds * 1000;
        const samplePromise = runSample(server.child.pid, options.sampleSeconds, samplePath);
        const persisted = await timed(() =>
          getFolder(server.baseUrl, targetPath, "full", ROOT_LIMIT)
        );
        const followupPersisted = [];
        while (performance.now() < sampleWindowDeadline) {
          const followup = await timed(() => getFolder(server.baseUrl, targetPath, "full", ROOT_LIMIT));
          if (followup.value.status !== 200) {
            throw new Error(
              `Follow-up persisted full request failed with status ${followup.value.status}: ${followup.value.bodyText}`
            );
          }
          followupPersisted.push(Number(followup.durationMs.toFixed(2)));
        }
        await samplePromise;

        iterations.push({
          iteration,
          coldMs: Number(cold.durationMs.toFixed(2)),
          coldStatus: cold.value.status,
          persistedMs: Number(persisted.durationMs.toFixed(2)),
          persistedStatus: persisted.value.status,
          followupPersisted: summarizeTimings(followupPersisted),
          samplePath,
        });

        if (persisted.value.status !== 200) {
          throw new Error(
            `Persisted full request failed with status ${persisted.value.status}: ${persisted.value.bodyText}`
          );
        }
      } finally {
        if (server?.child) {
          await stopBackend(server.child);
        }
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const persistedValues = iterations.map((item) => item.persistedMs);
  const meanPersisted =
    persistedValues.reduce((sum, value) => sum + value, 0) / persistedValues.length;
  const sorted = [...persistedValues].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const medianPersisted =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const report = {
    generatedAt: new Date().toISOString(),
    mediaRoot: options.mediaRoot,
    targetPath,
    estimatedMedia,
    iterations: iterations.length,
    sampleSeconds: options.sampleSeconds,
    rustProfile: options.rustProfile,
    results: iterations,
    summary: {
      persistedMeanMs: Number(meanPersisted.toFixed(2)),
      persistedMedianMs: Number(medianPersisted.toFixed(2)),
      persistedMinMs: Number(sorted[0].toFixed(2)),
      persistedMaxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    },
  };

  const reportPath = path.join(REPORT_DIR, `${nowStamp()}-rust-persisted-profile.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: "ok", reportPath, report }, null, 2)}\n`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
