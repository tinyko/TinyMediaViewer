import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.TMV_API_PROXY_TARGET ?? "http://localhost:4000";

function tmvDiagnosticsDevShim() {
  return {
    name: "tmv-diagnostics-dev-shim",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (
          req.method === "POST" &&
          (req.url === "/__tmv/diag/preview" || req.url === "/__tmv/diag/perf")
        ) {
          res.statusCode = 204;
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tmvDiagnosticsDevShim()],
  build: {
    target: "safari14",
    cssTarget: "safari14",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "safari14",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiProxyTarget,
      "/media": apiProxyTarget,
      "/thumb": apiProxyTarget,
    },
  },
});
