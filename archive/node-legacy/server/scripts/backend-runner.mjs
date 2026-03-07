import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_DIR = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend-rs");
const NODE_DIST_ENTRY = path.join(SERVER_DIR, "dist", "server.js");
const RUST_DEBUG_BIN = path.join(BACKEND_DIR, "target", "debug", "tmv-backend-app");
const RUST_RELEASE_BIN = path.join(BACKEND_DIR, "target", "release", "tmv-backend-app");
const VIEWER_DIR_CANDIDATES = [
  path.join(REPO_ROOT, "desktop", "src-tauri", "resources", "viewer"),
  path.join(REPO_ROOT, "web", "dist"),
];
const HOST = "127.0.0.1";
const builtBackends = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withCargoBinOnPath = (env) => {
  const home = env.HOME;
  if (!home) return env;
  const cargoBin = path.join(home, ".cargo", "bin");
  const currentPath = env.PATH || "";
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (entries.includes(cargoBin)) return env;
  return {
    ...env,
    PATH: currentPath ? `${currentPath}${path.delimiter}${cargoBin}` : cargoBin,
  };
};

const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: withCargoBinOnPath(process.env),
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });

export const pickFreePort = () =>
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

export const waitForHealth = async (baseUrl, timeoutMs = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(100);
  }
  throw new Error(`Backend did not become healthy within ${timeoutMs}ms`);
};

const buildCacheKey = (backend, options = {}) => {
  if (backend !== "rust") return backend;
  return `${backend}:${options.rustProfile ?? "debug"}`;
};

export const ensureBackendBuild = async (backend, options = {}) => {
  const cacheKey = buildCacheKey(backend, options);
  if (builtBackends.has(cacheKey)) {
    return;
  }

  if (backend === "node") {
    await runCommand("npm", ["run", "build"], SERVER_DIR);
    builtBackends.add(cacheKey);
    return;
  }

  if (backend === "rust") {
    const rustProfile = options.rustProfile ?? "debug";
    const cargoArgs =
      rustProfile === "release"
        ? ["build", "--release", "-p", "tmv-backend-app"]
        : ["build", "-p", "tmv-backend-app"];
    await runCommand(process.env.CARGO ?? "cargo", cargoArgs, BACKEND_DIR);
    builtBackends.add(cacheKey);
    return;
  }

  throw new Error(`Unsupported backend target: ${backend}`);
};

export const stopBackend = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(4_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
};

export const startBackend = async ({
  backend,
  mediaRoot,
  port,
  host = HOST,
  indexDir,
  thumbnailDir,
  diagnosticsDir,
  corsAllowedOrigins,
  extraEnv = {},
  rustProfile = "debug",
}) => {
  await ensureBackendBuild(backend, { rustProfile });
  const viewerDir = await resolveViewerDir();

  const commonEnv = {
    ...process.env,
    ...extraEnv,
  };
  let child;

  if (backend === "node") {
    child = spawn("node", [NODE_DIST_ENTRY], {
      cwd: SERVER_DIR,
      env: {
        PORT: String(port),
        SERVER_HOST: host,
        MEDIA_ROOT: mediaRoot,
        REQUIRE_LAN_TOKEN: "false",
        ENABLE_LIGHT_ROOT_MODE: "true",
        ENABLE_INDEX_PERSIST: "true",
        INDEX_DIR: indexDir,
        THUMBNAIL_CACHE_DIR: thumbnailDir,
        TMV_DIAGNOSTICS_DIR: diagnosticsDir,
        CORS_ALLOWED_ORIGINS: corsAllowedOrigins ?? `http://${host}:${port}`,
        ...commonEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else if (backend === "rust") {
    child = spawn(rustProfile === "release" ? RUST_RELEASE_BIN : RUST_DEBUG_BIN, [], {
      cwd: BACKEND_DIR,
      env: {
        TMV_RUNTIME_MODE: "legacy",
        TMV_MEDIA_ROOT: mediaRoot,
        TMV_PORT: String(port),
        TMV_BIND_HOST: host,
        TMV_REQUIRE_LAN_TOKEN: "false",
        TMV_ENABLE_LIGHT_ROOT_MODE: "true",
        TMV_INDEX_DIR: indexDir,
        TMV_THUMBNAIL_DIR: thumbnailDir,
        TMV_DIAGNOSTICS_DIR: diagnosticsDir,
        TMV_VIEWER_DIR: viewerDir,
        TMV_CORS_ALLOWED_ORIGINS: corsAllowedOrigins ?? `http://${host}:${port}`,
        ...commonEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    throw new Error(`Unsupported backend target: ${backend}`);
  }

  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);

  const baseUrl = `http://${host}:${port}`;
  await waitForHealth(baseUrl);
  return {
    backend,
    child,
    baseUrl,
  };
};

const resolveViewerDir = async () => {
  for (const candidate of VIEWER_DIR_CANDIDATES) {
    try {
      await fs.access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error("Unable to resolve viewer assets for Rust backend");
};
