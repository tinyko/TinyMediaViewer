import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import { runApiLoadLoop } from "./lib/api-benchmark.mjs";
import { createBenchmarkMediaRoot } from "./lib/fixture-media-root.mjs";
import { ensureDir, ensureEmptyDir, nowStamp, repoRoot, runCommand, startBackend, stopProcess } from "./lib/tmv-stack.mjs";

const profilePort = Number(process.env.TMV_PROFILE_PORT ?? 4400);
const sampleDurationSeconds = Number(process.env.TMV_PROFILE_DURATION_SECONDS ?? 12);

let backend = null;

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Backend profiling currently expects macOS `sample`.");
  }

  const stamp = nowStamp();
  const runtimeRoot = path.join(repoRoot, "backend-rs", ".tmp", `profile-${stamp}`);
  const mediaRoot = path.join(runtimeRoot, "media-root");
  const runtimeDir = path.join(runtimeRoot, "runtime");
  const outputDir = path.join(repoRoot, "output", "profiles");
  const outputPath = path.join(outputDir, `backend-sample-${stamp}.txt`);

  await ensureEmptyDir(runtimeRoot);
  await ensureDir(outputDir);
  const fixture = await createBenchmarkMediaRoot(mediaRoot, {
    accountCount: Number(process.env.TMV_PROFILE_ACCOUNTS ?? 16),
    imagesPerAccount: Number(process.env.TMV_PROFILE_IMAGES_PER_ACCOUNT ?? 32),
    videosPerAccount: Number(process.env.TMV_PROFILE_VIDEOS_PER_ACCOUNT ?? 8),
    strategy: "hardlink",
  });

  await runCommand("cargo", ["build", "--profile", "profiling", "-p", "tmv-backend-app"], {
    cwd: path.join(repoRoot, "backend-rs"),
    stdio: "inherit",
  });

  backend = await startBackend({
    port: profilePort,
    mediaRoot: fixture.rootDir,
    runtimeDir,
    profile: "profiling",
    useBuiltBinary: true,
    stdio: "inherit",
  });

  const sampleProcess = spawn(
    "sample",
    [
      String(backend.child.pid),
      String(sampleDurationSeconds),
      "5",
      "-mayDie",
      "-file",
      outputPath,
    ],
    {
      stdio: "inherit",
    }
  );

  const deadlineMs = Date.now() + sampleDurationSeconds * 1_000;
  await runApiLoadLoop({
    baseUrl: backend.baseUrl,
    accountPaths: fixture.accounts,
    deadlineMs,
  });
  const [code] = await once(sampleProcess, "exit");
  if (code !== 0) {
    throw new Error(`sample exited with code ${code}`);
  }

  console.log(`Backend profile report: ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopProcess(backend?.child);
  });
