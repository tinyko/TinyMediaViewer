import fs from "node:fs/promises";
import path from "node:path";
import { runApiBenchmarkSuite } from "./lib/api-benchmark.mjs";
import { createBenchmarkMediaRoot } from "./lib/fixture-media-root.mjs";
import { ensureDir, ensureEmptyDir, nowStamp, repoRoot, startBackend, stopProcess } from "./lib/tmv-stack.mjs";

const benchmarkPort = Number(process.env.TMV_BENCH_PORT ?? 4200);
const benchmarkProfile = process.env.TMV_BENCH_PROFILE ?? "release";
const iterations = Number(process.env.TMV_BENCH_ITERATIONS ?? 8);
const accountCount = Number(process.env.TMV_BENCH_ACCOUNTS ?? 12);
const imagesPerAccount = Number(process.env.TMV_BENCH_IMAGES_PER_ACCOUNT ?? 24);
const videosPerAccount = Number(process.env.TMV_BENCH_VIDEOS_PER_ACCOUNT ?? 6);

let backend = null;

async function main() {
  const stamp = nowStamp();
  const runtimeRoot = path.join(repoRoot, "backend-rs", ".tmp", `bench-${stamp}`);
  const mediaRoot = path.join(runtimeRoot, "media-root");
  const runtimeDir = path.join(runtimeRoot, "runtime");
  const outputDir = path.join(repoRoot, "output", "benchmarks");
  await ensureEmptyDir(runtimeRoot);
  await ensureDir(outputDir);

  const fixture = await createBenchmarkMediaRoot(mediaRoot, {
    accountCount,
    imagesPerAccount,
    videosPerAccount,
    strategy: "hardlink",
  });

  backend = await startBackend({
    port: benchmarkPort,
    mediaRoot: fixture.rootDir,
    runtimeDir,
    profile: benchmarkProfile,
    useBuiltBinary: true,
    stdio: "inherit",
  });

  const results = await runApiBenchmarkSuite({
    baseUrl: backend.baseUrl,
    accountPaths: fixture.accounts,
    iterations,
  });

  const report = {
    createdAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    backendProfile: benchmarkProfile,
    iterations,
    fixture,
    results: Object.fromEntries(
      Object.entries(results).map(([key, value]) => [
        key,
        {
          summary: value.summary,
          samplesMs: value.samplesMs,
        },
      ])
    ),
  };

  const outputPath = path.join(outputDir, `api-benchmark-${stamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  for (const [label, metric] of Object.entries(results)) {
    console.log(
      `${label}: avg=${metric.summary.avgMs.toFixed(2)}ms p95=${metric.summary.p95Ms.toFixed(
        2
      )}ms max=${metric.summary.maxMs.toFixed(2)}ms`
    );
  }
  console.log(`API benchmark report: ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopProcess(backend?.child);
  });
