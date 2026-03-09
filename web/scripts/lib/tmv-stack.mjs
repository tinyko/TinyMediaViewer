import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stackDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(stackDir, "../../..");
export const webDir = path.join(repoRoot, "web");
export const backendDir = path.join(repoRoot, "backend-rs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureEmptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function createMinimalViewerDir(dir) {
  await ensureDir(dir);
  await fs.writeFile(
    path.join(dir, "index.html"),
    "<!doctype html><html><body>TinyMediaViewer benchmark helper</body></html>\n",
    "utf8"
  );
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: options.stdio ?? "inherit",
  });

  return child;
}

export async function runCommand(command, args, options = {}) {
  const child = spawnProcess(command, args, options);
  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exited = once(child, "exit").catch(() => null);
  const timedOut = sleep(5_000).then(() => "timeout");
  const result = await Promise.race([exited, timedOut]);
  if (result === "timeout" && child.exitCode === null && !child.killed) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => null);
  }
}

export async function waitForUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError ?? "unknown error"}`);
}

function backendArgsForProfile(profile) {
  if (!profile || profile === "dev") {
    return ["build", "-p", "tmv-backend-app"];
  }
  if (profile === "release") {
    return ["build", "--release", "-p", "tmv-backend-app"];
  }
  return ["build", "--profile", profile, "-p", "tmv-backend-app"];
}

function backendBinaryPath(profile) {
  if (!profile || profile === "dev") {
    return path.join(backendDir, "target", "debug", "tmv-backend-app");
  }
  if (profile === "release") {
    return path.join(backendDir, "target", "release", "tmv-backend-app");
  }
  return path.join(backendDir, "target", profile, "tmv-backend-app");
}

async function buildBackendBinary(profile, stdio) {
  await runCommand("cargo", backendArgsForProfile(profile), {
    cwd: backendDir,
    stdio,
  });
}

export async function startBackend(options) {
  const {
    port,
    mediaRoot,
    runtimeDir,
    profile = "dev",
    useBuiltBinary = false,
    stdio = "inherit",
    extraEnv = {},
  } = options;

  const viewerDir = path.join(runtimeDir, "viewer");
  const indexDir = path.join(runtimeDir, "index");
  const thumbnailDir = path.join(runtimeDir, "thumbnails");
  const diagnosticsDir = path.join(runtimeDir, "diagnostics");
  await ensureDir(runtimeDir);
  await createMinimalViewerDir(viewerDir);
  await ensureDir(indexDir);
  await ensureDir(thumbnailDir);
  await ensureDir(diagnosticsDir);

  let child;
  const env = {
    TMV_RUNTIME_MODE: "legacy",
    TMV_MEDIA_ROOT: mediaRoot,
    TMV_BIND_HOST: "127.0.0.1",
    TMV_PORT: String(port),
    TMV_VIEWER_DIR: viewerDir,
    TMV_INDEX_DIR: indexDir,
    TMV_THUMBNAIL_DIR: thumbnailDir,
    TMV_DIAGNOSTICS_DIR: diagnosticsDir,
    TMV_ENABLE_LIGHT_ROOT_MODE: "false",
    ...extraEnv,
  };

  if (useBuiltBinary) {
    await buildBackendBinary(profile, stdio);
    child = spawnProcess(backendBinaryPath(profile), [], {
      cwd: backendDir,
      env,
      stdio,
    });
  } else {
    const args = ["run"];
    if (profile === "release") {
      args.push("--release");
    } else if (profile && profile !== "dev") {
      args.push("--profile", profile);
    }
    args.push("-p", "tmv-backend-app");
    child = spawnProcess("cargo", args, {
      cwd: backendDir,
      env,
      stdio,
    });
  }

  try {
    await waitForUrl(`http://127.0.0.1:${port}/health`);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }

  return {
    child,
    diagnosticsDir,
    indexDir,
    thumbnailDir,
    runtimeDir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

export async function startFrontend(options) {
  const { port, apiPort, stdio = "inherit" } = options;
  const child = spawnProcess(
    "npm",
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: webDir,
      env: {
        TMV_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      },
      stdio,
    }
  );

  try {
    await waitForUrl(`http://127.0.0.1:${port}`);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }

  return {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}
