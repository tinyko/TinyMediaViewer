import { defineConfig } from "@playwright/test";

const backendPort = Number(process.env.TMV_E2E_BACKEND_PORT ?? 4100);
const frontendPort = Number(process.env.TMV_E2E_FRONTEND_PORT ?? 4173);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { open: "never", outputFolder: "../output/playwright/report" }],
      ]
    : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    headless: true,
  },
  outputDir: "../output/playwright/test-results",
  webServer: [
    {
      command: "node ./scripts/start-e2e-backend.mjs",
      url: `http://127.0.0.1:${backendPort}/health`,
      cwd: ".",
      reuseExistingServer: false,
      env: {
        TMV_E2E_BACKEND_PORT: String(backendPort),
      },
      timeout: 180_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      url: `http://127.0.0.1:${frontendPort}`,
      cwd: ".",
      reuseExistingServer: false,
      env: {
        TMV_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
      },
      timeout: 120_000,
    },
  ],
});
