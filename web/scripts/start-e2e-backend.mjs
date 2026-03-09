import path from "node:path";
import { createE2EMediaRoot } from "./lib/fixture-media-root.mjs";
import { ensureEmptyDir, repoRoot, startBackend, stopProcess } from "./lib/tmv-stack.mjs";

const backendPort = Number(process.env.TMV_E2E_BACKEND_PORT ?? 4100);
const runtimeRoot = path.join(repoRoot, "backend-rs", ".tmp", "playwright-e2e");
const mediaRoot = path.join(runtimeRoot, "media-root");
const runtimeDir = path.join(runtimeRoot, "runtime");

let shuttingDown = false;
let backend = null;

async function main() {
  await ensureEmptyDir(runtimeRoot);
  await createE2EMediaRoot(mediaRoot);
  backend = await startBackend({
    port: backendPort,
    mediaRoot,
    runtimeDir,
    profile: process.env.TMV_E2E_BACKEND_PROFILE ?? "dev",
    stdio: "inherit",
  });
  process.stdout.write(`TMV E2E backend ready at ${backend.baseUrl}\n`);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopProcess(backend?.child);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  backend.child.once("exit", (code) => {
    if (!shuttingDown) {
      process.exit(code ?? 1);
    }
  });
}

main().catch((error) => {
  console.error(error);
  void stopProcess(backend?.child).finally(() => process.exit(1));
});
