#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(SERVER_DIR, "perf-reports");

const nowStamp = () => {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mediaRoot: process.env.MEDIA_ROOT,
    fixtureMode: process.env.PERF_FIXTURE_MODE ?? "real",
    rustProfile: process.env.PERF_COMPARE_RUST_PROFILE ?? "release",
    iterations: Number(process.env.PERF_COMPARE_ITERATIONS ?? 1),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--media-root") {
      options.mediaRoot = args[index + 1] ?? options.mediaRoot;
      index += 1;
    } else if (arg === "--fixture-mode") {
      options.fixtureMode = args[index + 1] ?? options.fixtureMode;
      index += 1;
    } else if (arg === "--rust-profile") {
      options.rustProfile = args[index + 1] ?? options.rustProfile;
      index += 1;
    } else if (arg === "--iterations") {
      options.iterations = Number(args[index + 1] ?? options.iterations);
      index += 1;
    }
  }

  options.iterations = Number.isFinite(options.iterations) && options.iterations > 0
    ? Math.floor(options.iterations)
    : 1;

  return options;
};

const runCommand = (command, args, cwd, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });

const listJsonReports = async () => {
  try {
    return (await fs.readdir(REPORT_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(REPORT_DIR, name));
  } catch {
    return [];
  }
};

const runBench = async ({ backend, mediaRoot, fixtureMode, rustProfile }) => {
  const before = new Set(await listJsonReports());
  const env = {
    ...process.env,
    PERF_BACKEND: backend,
    PERF_FIXTURE_MODE: fixtureMode,
  };
  if (mediaRoot) {
    env.MEDIA_ROOT = mediaRoot;
  }
  if (backend === "rust") {
    env.PERF_RUST_PROFILE = rustProfile;
  }

  await runCommand("node", ["scripts/perf-bench.mjs"], SERVER_DIR, env);

  const after = await listJsonReports();
  const newest = after
    .filter((reportPath) => !before.has(reportPath))
    .sort()
    .at(-1);

  if (!newest) {
    throw new Error(`Unable to determine perf report path for ${backend}`);
  }

  const payload = JSON.parse(await fs.readFile(newest, "utf8"));
  return { reportPath: newest, payload };
};

const readMetric = (payload, metric) => {
  switch (metric) {
    case "s1ColdMs":
      return Number(payload.scenarios?.s1?.coldSingleMs ?? Number.NaN);
    case "s1PersistedMs":
      return Number(payload.scenarios?.s1?.persistedRestartMs ?? Number.NaN);
    case "s2P95Ms":
      return Number(payload.scenarios?.s2?.p95Ms ?? Number.NaN);
    case "s3P95Ms":
      return Number(payload.scenarios?.s3?.p95Ms ?? Number.NaN);
    case "s4ColdMs":
      return Number(payload.scenarios?.s4?.coldMs ?? Number.NaN);
    case "s4PersistedMs":
      return Number(payload.scenarios?.s4?.persistedRestartMs ?? Number.NaN);
    case "s4HotP95Ms":
      return Number(payload.scenarios?.s4?.hotP95Ms ?? Number.NaN);
    case "peakRssMB":
      return Number(
        ((payload.scenarios?.s6?.peakRssBytes ?? Number.NaN) / 1024 / 1024).toFixed(2)
      );
    default:
      throw new Error(`Unsupported metric ${metric}`);
  }
};

const percentDelta = (nodeValue, rustValue) => {
  if (!Number.isFinite(nodeValue) || nodeValue === 0 || !Number.isFinite(rustValue)) {
    return null;
  }
  return Number((((nodeValue - rustValue) / nodeValue) * 100).toFixed(2));
};

const compareMetric = (nodePayload, rustPayload, metric) => {
  const nodeValue = readMetric(nodePayload, metric);
  const rustValue = readMetric(rustPayload, metric);
  return {
    metric,
    node: nodeValue,
    rust: rustValue,
    rustImprovementPct: percentDelta(nodeValue, rustValue),
  };
};

const stats = (values) => {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      stddev: null,
    };
  }
  const sorted = [...numeric].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    stddev: Number(Math.sqrt(variance).toFixed(2)),
  };
};

const summarizeMetric = (runs, metric) => {
  const nodeValues = runs.map((run) => readMetric(run.node.payload, metric));
  const rustValues = runs.map((run) => readMetric(run.rust.payload, metric));
  const nodeStats = stats(nodeValues);
  const rustStats = stats(rustValues);
  return {
    metric,
    node: nodeStats,
    rust: rustStats,
    rustMedianImprovementPct: percentDelta(nodeStats.median, rustStats.median),
    rustMeanImprovementPct: percentDelta(nodeStats.mean, rustStats.mean),
  };
};

const extractStatuses = (payload) => ({
  s1: {
    cold: Number(payload.scenarios?.s1?.status ?? 0),
    persisted: Number(payload.scenarios?.s1?.persistedStatus ?? 0),
  },
  s4: {
    cold: Number(payload.scenarios?.s4?.coldStatus ?? 0),
    persisted: Number(payload.scenarios?.s4?.persistedStatus ?? 0),
  },
  s5: {
    full: Number(payload.scenarios?.s5?.fullDownload?.status ?? 0),
    range: Number(payload.scenarios?.s5?.rangeRequest?.status ?? 0),
  },
});

const collectStatusFailures = (label, statuses) => {
  const failures = [];
  if (statuses.s1.cold !== 200) {
    failures.push(`${label} s1 cold status=${statuses.s1.cold}`);
  }
  if (statuses.s1.persisted !== 200) {
    failures.push(`${label} s1 persisted status=${statuses.s1.persisted}`);
  }
  if (statuses.s4.cold !== 200) {
    failures.push(`${label} s4 cold status=${statuses.s4.cold}`);
  }
  if (statuses.s4.persisted !== 200) {
    failures.push(`${label} s4 persisted status=${statuses.s4.persisted}`);
  }
  if (statuses.s5.full !== 200) {
    failures.push(`${label} s5 full status=${statuses.s5.full}`);
  }
  if (statuses.s5.range !== 206) {
    failures.push(`${label} s5 range status=${statuses.s5.range}`);
  }
  return failures;
};

const main = async () => {
  const options = parseArgs();
  await fs.mkdir(REPORT_DIR, { recursive: true });

  const runs = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const nodeRun = await runBench({
      backend: "node",
      mediaRoot: options.mediaRoot,
      fixtureMode: options.fixtureMode,
      rustProfile: options.rustProfile,
    });
    const rustRun = await runBench({
      backend: "rust",
      mediaRoot: options.mediaRoot,
      fixtureMode: options.fixtureMode,
      rustProfile: options.rustProfile,
    });
    runs.push({
      iteration: iteration + 1,
      node: nodeRun,
      rust: rustRun,
    });
  }

  const latestRun = runs[runs.length - 1];
  const metrics = [
    "s1ColdMs",
    "s1PersistedMs",
    "s2P95Ms",
    "s3P95Ms",
    "s4ColdMs",
    "s4PersistedMs",
    "s4HotP95Ms",
    "peakRssMB",
  ].map((metric) =>
    runs.length === 1
      ? compareMetric(latestRun.node.payload, latestRun.rust.payload, metric)
      : summarizeMetric(runs, metric)
  );
  const statuses = {
    node: extractStatuses(latestRun.node.payload),
    rust: extractStatuses(latestRun.rust.payload),
  };
  const statusFailures = [
    ...collectStatusFailures("node", statuses.node),
    ...collectStatusFailures("rust", statuses.rust),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    fixtureMode: options.fixtureMode,
    mediaRoot:
      latestRun.node.payload.mediaRoot ??
      latestRun.rust.payload.mediaRoot ??
      options.mediaRoot ??
      null,
    rustProfile: options.rustProfile,
    iterations: options.iterations,
    nodeReportPath: latestRun.node.reportPath,
    rustReportPath: latestRun.rust.reportPath,
    statuses,
    runs: runs.map((run) => ({
      iteration: run.iteration,
      nodeReportPath: run.node.reportPath,
      rustReportPath: run.rust.reportPath,
      statuses: {
        node: extractStatuses(run.node.payload),
        rust: extractStatuses(run.rust.payload),
      },
    })),
    metrics,
  };

  const reportPath = path.join(REPORT_DIR, `${nowStamp()}-compare-node-vs-rust.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        reportPath,
        nodeReportPath: latestRun.node.reportPath,
        rustReportPath: latestRun.rust.reportPath,
        iterations: options.iterations,
        statuses,
        metrics,
      },
      null,
      2
    )}\n`
  );

  if (statusFailures.length) {
    for (const failure of statusFailures) {
      console.error(failure);
    }
    process.exitCode = 1;
  }
};

await main();
