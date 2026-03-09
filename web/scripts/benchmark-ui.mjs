import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { createE2EMediaRoot } from "./lib/fixture-media-root.mjs";
import { ensureDir, ensureEmptyDir, nowStamp, repoRoot, startBackend, startFrontend, stopProcess } from "./lib/tmv-stack.mjs";

const backendPort = Number(process.env.TMV_UI_BENCH_BACKEND_PORT ?? 4460);
const frontendPort = Number(process.env.TMV_UI_BENCH_FRONTEND_PORT ?? 4373);

let backend = null;
let frontend = null;

async function main() {
  const stamp = nowStamp();
  const runtimeRoot = path.join(repoRoot, "backend-rs", ".tmp", `ui-bench-${stamp}`);
  const mediaRoot = path.join(runtimeRoot, "media-root");
  const runtimeDir = path.join(runtimeRoot, "runtime");
  const outputDir = path.join(repoRoot, "output", "benchmarks");
  await ensureEmptyDir(runtimeRoot);
  await ensureDir(outputDir);

  await createE2EMediaRoot(mediaRoot);
  backend = await startBackend({
    port: backendPort,
    mediaRoot,
    runtimeDir,
    profile: "dev",
    useBuiltBinary: true,
    stdio: "inherit",
  });
  frontend = await startFrontend({
    port: frontendPort,
    apiPort: backendPort,
    stdio: "inherit",
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const alphaAccountButton = page.getByRole("button", { name: /^alpha-lounge\b/ });

  const startedAt = performance.now();
  await page.goto(frontend.baseUrl, { waitUntil: "domcontentloaded" });
  await alphaAccountButton.waitFor();
  const rootReadyMs = performance.now() - startedAt;

  const navigationEntry = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    if (!entry) return null;
    return {
      domContentLoadedMs: entry.domContentLoadedEventEnd - entry.startTime,
      loadMs: entry.loadEventEnd - entry.startTime,
      responseEndMs: entry.responseEnd - entry.startTime,
    };
  });

  await alphaAccountButton.click();
  await page.getByRole("button", { name: /IMG_20260307_000001\.png/ }).waitFor();

  const imagePreviewStartedAt = performance.now();
  await page.getByRole("button", { name: /IMG_20260307_000001\.png/ }).click();
  await page.getByRole("dialog").waitFor();
  const imagePreviewOpenMs = performance.now() - imagePreviewStartedAt;
  await page.getByRole("button", { name: "关闭" }).last().click();
  await page.getByRole("dialog").waitFor({ state: "detached" });

  const systemUsageStartedAt = performance.now();
  await page.getByRole("button", { name: "系统占用情况" }).click();
  await page.getByRole("dialog", { name: "系统占用情况" }).waitFor();
  const systemUsageOpenMs = performance.now() - systemUsageStartedAt;
  await page.getByRole("button", { name: "关闭" }).first().click();
  await page.getByRole("dialog", { name: "系统占用情况" }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "视频" }).click();
  await page.getByRole("button", { name: /VID_20260307_000001\.mp4/ }).waitFor();

  const videoPreviewStartedAt = performance.now();
  await page.getByRole("button", { name: /VID_20260307_000001\.mp4/ }).click();
  await page.locator("video").waitFor();
  const videoPreviewOpenMs = performance.now() - videoPreviewStartedAt;

  const screenshotPath = path.join(outputDir, `ui-benchmark-${stamp}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  await browser.close();

  const report = {
    createdAt: new Date().toISOString(),
    baseUrl: frontend.baseUrl,
    navigation: navigationEntry,
    timings: {
      rootReadyMs,
      imagePreviewOpenMs,
      systemUsageOpenMs,
      videoPreviewOpenMs,
    },
    screenshotPath,
  };

  const outputPath = path.join(outputDir, `ui-benchmark-${stamp}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));

  console.log(`UI benchmark report: ${outputPath}`);
  console.log(`UI benchmark screenshot: ${screenshotPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopProcess(frontend?.child);
    await stopProcess(backend?.child);
  });
