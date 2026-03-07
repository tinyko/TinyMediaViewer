#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(SERVER_DIR, "perf-reports");

const THRESHOLDS = {
  s1Ms: 2000,
  s2P95Ms: 2500,
  s3P95Ms: 120,
  s4ColdMs: 120,
  s4HotP95Ms: 80,
  s6PeakRssBytes: 350 * 1024 * 1024,
};

const parseReportArg = () => {
  const reportFlag = process.argv.indexOf("--report");
  if (reportFlag !== -1 && process.argv[reportFlag + 1]) {
    return path.resolve(process.argv[reportFlag + 1]);
  }
  if (process.argv[2] && process.argv[2] !== "--report") {
    return path.resolve(process.argv[2]);
  }
  return null;
};

const findLatestReport = async () => {
  const names = await fs.readdir(REPORT_DIR);
  const jsonFiles = names.filter((name) => name.endsWith(".json")).sort();
  if (!jsonFiles.length) {
    throw new Error("No perf report found in server/perf-reports");
  }
  return path.join(REPORT_DIR, jsonFiles[jsonFiles.length - 1]);
};

const run = async () => {
  const reportPath = parseReportArg() ?? (await findLatestReport());
  const payload = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const scenarios = payload.scenarios ?? {};
  const backend = payload.backend ?? "node";
  const fixtureMode = payload.fixture?.mode ?? "real";
  const failures = [];

  const s1Ms = Number(scenarios.s1?.coldSingleMs ?? Number.POSITIVE_INFINITY);
  if (!(s1Ms < THRESHOLDS.s1Ms)) {
    failures.push(`S1 failed: ${s1Ms}ms (expected < ${THRESHOLDS.s1Ms}ms)`);
  }
  const s1Status = Number(scenarios.s1?.status ?? 0);
  if (s1Status !== 200) {
    failures.push(`S1 failed: status=${s1Status} (expected 200)`);
  }

  const s1PersistedMs = Number(
    scenarios.s1?.persistedRestartMs ?? Number.POSITIVE_INFINITY
  );
  const s1PersistedStatus = Number(scenarios.s1?.persistedStatus ?? 0);
  if (s1PersistedStatus !== 200) {
    failures.push(`S1 persisted failed: status=${s1PersistedStatus} (expected 200)`);
  }

  const s2P95Ms = Number(scenarios.s2?.p95Ms ?? Number.POSITIVE_INFINITY);
  if (!(s2P95Ms < THRESHOLDS.s2P95Ms)) {
    failures.push(`S2 failed: p95 ${s2P95Ms}ms (expected < ${THRESHOLDS.s2P95Ms}ms)`);
  }

  const s3P95Ms = Number(scenarios.s3?.p95Ms ?? Number.POSITIVE_INFINITY);
  if (!(s3P95Ms < THRESHOLDS.s3P95Ms)) {
    failures.push(`S3 failed: p95 ${s3P95Ms}ms (expected < ${THRESHOLDS.s3P95Ms}ms)`);
  }

  const s4ColdMs = Number(scenarios.s4?.coldMs ?? Number.POSITIVE_INFINITY);
  if (!(s4ColdMs < THRESHOLDS.s4ColdMs)) {
    failures.push(`S4 cold failed: ${s4ColdMs}ms (expected < ${THRESHOLDS.s4ColdMs}ms)`);
  }
  const hasS4Persisted =
    typeof scenarios.s4?.persistedRestartMs === "number" ||
    typeof scenarios.s4?.persistedStatus === "number";
  const s4PersistedMs = Number(
    scenarios.s4?.persistedRestartMs ?? Number.POSITIVE_INFINITY
  );
  const s4PersistedStatus = Number(scenarios.s4?.persistedStatus ?? 0);
  if (hasS4Persisted && s4PersistedStatus !== 200) {
    failures.push(`S4 persisted failed: status=${s4PersistedStatus} (expected 200)`);
  }

  const s4HotP95Ms = Number(scenarios.s4?.hotP95Ms ?? Number.POSITIVE_INFINITY);
  if (!(s4HotP95Ms < THRESHOLDS.s4HotP95Ms)) {
    failures.push(
      `S4 hot failed: p95 ${s4HotP95Ms}ms (expected < ${THRESHOLDS.s4HotP95Ms}ms)`
    );
  }

  const peakRssBytes = Number(
    scenarios.s6?.peakRssBytes ?? Number.POSITIVE_INFINITY
  );
  if (!(peakRssBytes < THRESHOLDS.s6PeakRssBytes)) {
    const rssMb = Number((peakRssBytes / 1024 / 1024).toFixed(2));
    failures.push(`S6 failed: RSS ${rssMb}MB (expected < 350MB)`);
  }

  const fullStatus = Number(scenarios.s5?.fullDownload?.status ?? 0);
  const rangeStatus = Number(scenarios.s5?.rangeRequest?.status ?? 0);
  if (fullStatus !== 200) {
    failures.push(`S5 full download failed: status=${fullStatus} (expected 200)`);
  }
  if (rangeStatus !== 206) {
    failures.push(`S5 range request failed: status=${rangeStatus} (expected 206)`);
  }

  console.log(`Perf report: ${reportPath}`);
  console.log(
    JSON.stringify(
      {
        backend,
        fixtureMode,
        s1Ms,
        s1PersistedMs,
        s1Statuses: {
          cold: s1Status,
          persisted: s1PersistedStatus,
        },
        s2P95Ms,
        s3P95Ms,
        s4ColdMs,
        s4PersistedMs: hasS4Persisted ? s4PersistedMs : null,
        s4Statuses: hasS4Persisted
          ? { cold: Number(scenarios.s4?.coldStatus ?? 0), persisted: s4PersistedStatus }
          : undefined,
        s4HotP95Ms,
        s6PeakRssMB: Number((peakRssBytes / 1024 / 1024).toFixed(2)),
        s5Statuses: { full: fullStatus, range: rangeStatus },
      },
      null,
      2
    )
  );

  if (failures.length) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Performance thresholds PASSED.");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
