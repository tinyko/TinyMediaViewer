import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { pickFreePort, startBackend, stopBackend } from "./backend-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIR = path.join(REPO_ROOT, "web");
const OUTPUT_DIR = path.join(REPO_ROOT, "output", "playwright");
const TMP_ROOT = path.join(REPO_ROOT, "server", ".tmp");
const HOST = "127.0.0.1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    backend: process.env.PLAYWRIGHT_SMOKE_BACKEND ?? "both",
    mediaRoot: process.env.MEDIA_ROOT ?? process.env.TMV_MEDIA_ROOT ?? path.join(REPO_ROOT),
    headed: process.env.PLAYWRIGHT_SMOKE_HEADED === "true",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--backend") {
      options.backend = args[index + 1] ?? options.backend;
      index += 1;
    } else if (arg === "--media-root") {
      options.mediaRoot = args[index + 1] ?? options.mediaRoot;
      index += 1;
    } else if (arg === "--headed") {
      options.headed = true;
    }
  }

  if (!["node", "rust", "both"].includes(options.backend)) {
    throw new Error(`Unsupported backend target: ${options.backend}`);
  }

  return options;
};

const waitForUrl = async (url, timeoutMs = 30_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling until timeout
    }
    await sleep(100);
  }
  throw new Error(`URL did not become ready within ${timeoutMs}ms: ${url}`);
};

const startVite = async ({ backendPort, viewerPort }) => {
  const viewerUrl = `http://${HOST}:${viewerPort}`;
  const child = spawn("npm", ["run", "dev", "--", "--host", HOST, "--port", String(viewerPort)], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      TMV_API_PROXY_TARGET: `http://${HOST}:${backendPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);

  await waitForUrl(viewerUrl);
  return {
    child,
    viewerUrl,
  };
};

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const startedAt = Date.now();
  while (child.exitCode === null && Date.now() - startedAt < 4_000) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
};

const takeScreenshotPath = (backend) => {
  const fileName = `${backend}-smoke-${new Date().toISOString().replaceAll(":", "-")}.png`;
  return path.join(OUTPUT_DIR, fileName);
};

const writeJsonPath = (backend) => {
  const fileName = `${backend}-smoke-${new Date().toISOString().replaceAll(":", "-")}.json`;
  return path.join(OUTPUT_DIR, fileName);
};

const pickFirstVideoAccountText = async (page) => {
  const entries = await page.locator(".category-item").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent ?? "",
      path: node.getAttribute("data-path") ?? "",
    }))
  );
  return entries.find((entry) => /🎞️\s*[1-9]\d*/u.test(entry.text)) ?? null;
};

const waitForVideoAccount = async (page, timeoutMs = 20_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const candidate = await pickFirstVideoAccountText(page);
    if (candidate) {
      return candidate;
    }
    await page.waitForTimeout(250);
  }
  return null;
};

const runSmoke = async ({ backend, mediaRoot, headed }) => {
  const backendPort = await pickFreePort();
  const viewerPort = await pickFreePort();
  const stamp = `${backend}-${Date.now()}`;
  const runtimeDir = path.join(TMP_ROOT, `playwright-smoke-${stamp}`);
  const indexDir = path.join(runtimeDir, "index");
  const thumbnailDir = path.join(runtimeDir, "thumb");
  const diagnosticsDir = path.join(runtimeDir, "diag");
  const viewerOrigin = `http://${HOST}:${viewerPort}`;

  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let backendHandle;
  let viteHandle;
  let browser;

  try {
    backendHandle = await startBackend({
      backend,
      mediaRoot,
      port: backendPort,
      indexDir,
      thumbnailDir,
      diagnosticsDir,
      corsAllowedOrigins: viewerOrigin,
    });
    viteHandle = await startVite({ backendPort, viewerPort });

    browser = await chromium.launch({ headless: !headed });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(viteHandle.viewerUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".category-item", { timeout: 30_000 });
    await page.waitForSelector(".media-card", { timeout: 30_000 });

    const title = await page.title();
    if (title !== "Tiny Media Viewer") {
      throw new Error(`Unexpected viewer title for ${backend}: ${title}`);
    }

    await page.locator(".category-preview").evaluate((node) => {
      node.scrollTo({ top: Math.max(240, node.scrollHeight * 0.25) });
    });
    await sleep(500);

    await page.getByRole("button", { name: "视频" }).click();
    await page.waitForSelector(".category-item", { timeout: 30_000 });
    await page.waitForSelector(".media-card", { timeout: 30_000 });

    const firstVideoAccount = await waitForVideoAccount(page);
    if (!firstVideoAccount) {
      throw new Error(`No non-zero video account visible for ${backend}`);
    }

    const visibleMediaCards = await page.locator(".media-card").count();
    if (!visibleMediaCards) {
      throw new Error(`No media cards visible after video filter for ${backend}`);
    }

    await page.locator(".media-card").first().click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 15_000 });

    const screenshotPath = takeScreenshotPath(backend);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.getByRole("button", { name: "关闭" }).last().click();
    await page.waitForTimeout(200);

    const summary = {
      backend,
      mediaRoot,
      viewerUrl: viteHandle.viewerUrl,
      backendUrl: backendHandle.baseUrl,
      firstVideoAccount,
      visibleMediaCards,
      screenshotPath,
      consoleErrors,
      pageErrors,
    };
    const summaryPath = writeJsonPath(backend);
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    if (consoleErrors.length || pageErrors.length) {
      throw new Error(
        `${backend} viewer emitted browser errors: ${JSON.stringify({ consoleErrors, pageErrors })}`
      );
    }

    return {
      ...summary,
      summaryPath,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await stopProcess(viteHandle?.child).catch(() => undefined);
    await stopBackend(backendHandle?.child).catch(() => undefined);
  }
};

const main = async () => {
  const options = parseArgs();
  const backends = options.backend === "both" ? ["node", "rust"] : [options.backend];
  const results = [];

  for (const backend of backends) {
    results.push(await runSmoke({ backend, mediaRoot: options.mediaRoot, headed: options.headed }));
  }

  const printable = results.map((entry) => ({
    backend: entry.backend,
    viewerUrl: entry.viewerUrl,
    backendUrl: entry.backendUrl,
    firstVideoAccount: entry.firstVideoAccount,
    visibleMediaCards: entry.visibleMediaCards,
    screenshotPath: entry.screenshotPath,
    summaryPath: entry.summaryPath,
  }));

  process.stdout.write(`${JSON.stringify({ status: "ok", results: printable }, null, 2)}\n`);
};

await main();
