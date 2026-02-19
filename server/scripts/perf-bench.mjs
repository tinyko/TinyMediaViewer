#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import net from "node:net";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(SERVER_DIR, "dist", "server.js");
const REPORT_DIR = path.join(SERVER_DIR, "perf-reports");
const TMP_DIR = path.join(SERVER_DIR, ".tmp");
const INDEX_DIR = path.join(TMP_DIR, "perf-index");
const DEFAULT_MEDIA_ROOT = "/Users/tiny/X";
const HOST = "127.0.0.1";
const ROOT_LIMIT = 240;
const HOT_LOOP = 50;
const S4_HOT_LOOP = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const ensureDist = async () => {
  try {
    await fs.access(DIST_ENTRY);
  } catch {
    await runCommand("npm", ["run", "build"], SERVER_DIR);
  }
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

const pickFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to pick free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const waitForHealth = async (baseUrl, timeoutMs = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until ready or timeout.
    }
    await sleep(100);
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
};

const startServer = async ({ mediaRoot, port }) => {
  const env = {
    ...process.env,
    PORT: String(port),
    SERVER_HOST: HOST,
    MEDIA_ROOT: mediaRoot,
    REQUIRE_LAN_TOKEN: "false",
    ENABLE_LIGHT_ROOT_MODE: "true",
    ENABLE_INDEX_PERSIST: "true",
    INDEX_DIR: INDEX_DIR,
    CORS_ALLOWED_ORIGINS: `http://${HOST}:${port}`,
  };

  const child = spawn("node", [DIST_ENTRY], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);

  const baseUrl = `http://${HOST}:${port}`;
  await waitForHealth(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(4_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
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
  const mediaRoot = path.resolve(process.env.MEDIA_ROOT ?? DEFAULT_MEDIA_ROOT);
  const previewBatchLimit = Number(process.env.PREVIEW_BATCH_LIMIT ?? 64);
  const rssSamples = {
    s1: 0,
    s2: 0,
    s4: 0,
  };

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.rm(INDEX_DIR, { recursive: true, force: true });
  await ensureDist();

  const port = Number(process.env.PERF_PORT ?? (await pickFreePort()));
  let server = null;

  const scenario = {
    s1: {
      coldSingleMs: 0,
      status: 0,
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
    server = await startServer({ mediaRoot, port });
    const s1 = await timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT));
    scenario.s1.coldSingleMs = Number(s1.durationMs.toFixed(2));
    scenario.s1.status = s1.value.status;
    rssSamples.s1 = await getRssBytes(server.child.pid);
    await stopServer(server.child);
    server = null;

    server = await startServer({ mediaRoot, port });
    const s2Runs = await Promise.all(
      Array.from({ length: 4 }).map(() =>
        timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT))
      )
    );
    scenario.s2.coldConcurrentMs = s2Runs.map((run) => Number(run.durationMs.toFixed(2)));
    scenario.s2.statuses = s2Runs.map((run) => run.value.status);
    scenario.s2.p95Ms = Number(percentile(scenario.s2.coldConcurrentMs, 0.95).toFixed(2));
    rssSamples.s2 = await getRssBytes(server.child.pid);
    await stopServer(server.child);
    server = null;

    server = await startServer({ mediaRoot, port });
    await getFolder(server.baseUrl, "", "light", ROOT_LIMIT);
    for (let i = 0; i < HOT_LOOP; i += 1) {
      const timedRun = await timed(() => getFolder(server.baseUrl, "", "light", ROOT_LIMIT));
      scenario.s3.hotSerialMs.push(Number(timedRun.durationMs.toFixed(2)));
    }
    scenario.s3.p95Ms = Number(percentile(scenario.s3.hotSerialMs, 0.95).toFixed(2));
    await stopServer(server.child);
    server = null;

    server = await startServer({ mediaRoot, port });
    const target = await findLargestFolder(server.baseUrl, previewBatchLimit);
    scenario.s4.targetPath = target.path;
    scenario.s4.estimatedMedia = target.estimatedMedia;

    const s4Cold = await timed(() =>
      getFolder(server.baseUrl, target.path, "full", ROOT_LIMIT)
    );
    scenario.s4.coldMs = Number(s4Cold.durationMs.toFixed(2));
    scenario.s4.coldStatus = s4Cold.value.status;

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
      await stopServer(server.child);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mediaRoot,
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
        s1Ms: report.scenarios.s1.coldSingleMs,
        s2P95Ms: report.scenarios.s2.p95Ms,
        s3P95Ms: report.scenarios.s3.p95Ms,
        s4ColdMs: report.scenarios.s4.coldMs,
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
