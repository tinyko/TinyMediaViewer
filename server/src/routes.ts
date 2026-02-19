import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppConfig, isOriginAllowed } from "./config";
import { FolderMode, MediaScanner } from "./scanner";

export async function registerRoutes(
  fastify: FastifyInstance,
  scanner: MediaScanner,
  appConfig: AppConfig
) {
  const diagnosticsDir = process.env.TMV_DIAGNOSTICS_DIR?.trim() || "";

  fastify.get("/health", async () => ({ status: "ok" }));

  const guardRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!isOriginAllowed(origin, appConfig)) {
      reply.status(403).send({ error: "Origin not allowed" });
      return false;
    }

    if (appConfig.requireLanToken && !isLoopbackIp(request.ip)) {
      const tokenHeader = request.headers["x-media-viewer-token"];
      const providedToken = Array.isArray(tokenHeader)
        ? tokenHeader[0]
        : tokenHeader;
      if (!providedToken || providedToken !== appConfig.mediaAccessToken) {
        reply.status(401).send({ error: "Unauthorized LAN request" });
        return false;
      }
    }

    return true;
  };

  fastify.get("/api/folder", async (request, reply): Promise<unknown> => {
    if (!(await guardRequest(request, reply))) return;
    const query = request.query as {
      path?: string;
      cursor?: string;
      limit?: string;
      mode?: string;
    };
    const targetPath = query.path ?? "";
    const limit = query.limit ? Number(query.limit) : undefined;

    try {
      const mode = parseMode(query.mode, targetPath, appConfig.enableLightRootMode);
      return await scanner.getFolder(targetPath, {
        cursor: query.cursor,
        limit,
        mode,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read folder";
      reply.status(400);
      return { error: message };
    }
  });

  fastify.post("/api/folder/previews", async (request, reply): Promise<unknown> => {
    if (!(await guardRequest(request, reply))) return;
    const body = request.body as {
      paths?: unknown;
      limitPerFolder?: unknown;
    };

    if (!Array.isArray(body?.paths)) {
      reply.status(400);
      return { error: "paths must be an array" };
    }
    if (!body.paths.length) {
      return { items: [] };
    }
    if (body.paths.length > appConfig.previewBatchLimit) {
      reply.status(400);
      return {
        error: `paths size exceeds PREVIEW_BATCH_LIMIT=${appConfig.previewBatchLimit}`,
      };
    }

    const paths = body.paths.filter((item): item is string => typeof item === "string");
    if (paths.length !== body.paths.length) {
      reply.status(400);
      return { error: "paths must be string array" };
    }

    const limitPerFolder =
      typeof body.limitPerFolder === "number" && Number.isFinite(body.limitPerFolder)
        ? body.limitPerFolder
        : undefined;

    try {
      const startedAt = Date.now();
      const result = await scanner.getFolderPreviews(paths, limitPerFolder);
      const durationMs = Date.now() - startedAt;

      fastify.log.info(
        {
          requestPathCount: paths.length,
          successCount: result.items.length,
          failedCount: result.errors.length,
          durationMs,
          slowestPath: result.slowestPath ?? null,
          slowestMs: result.slowestMs,
        },
        "folder preview batch completed"
      );

      void appendPreviewBatchLog(diagnosticsDir, {
        ts: Date.now(),
        requestPathCount: paths.length,
        successCount: result.items.length,
        failedCount: result.errors.length,
        durationMs,
        slowestPath: result.slowestPath,
        slowestMs: result.slowestMs,
        failures: result.errors,
      });

      return {
        items: result.items,
        errors: result.errors,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to build folder previews";
      reply.status(400);
      return { error: message };
    }
  });

  fastify.get("/media/*", async (request, reply) => {
    if (!(await guardRequest(request, reply))) return;
    const wildcardPath = (request.params as { "*": string })["*"] ?? "";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(wildcardPath);
    } catch {
      reply.status(400);
      return { error: "Invalid media path encoding" };
    }

    try {
      const { absolutePath } = scanner.resolveMediaFile(decodedPath);
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        reply.status(404);
        return { error: "Media file not found" };
      }

      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = contentTypeByExt(ext);
      const range = typeof request.headers.range === "string" ? request.headers.range : undefined;

      reply.header("Cache-Control", "public, max-age=86400");
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Type", contentType);

      if (range) {
        const parsed = parseByteRange(range, stats.size);
        if (!parsed) {
          reply.code(416);
          reply.header("Content-Range", `bytes */${stats.size}`);
          return;
        }
        const { start, end } = parsed;
        reply.code(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${stats.size}`);
        reply.header("Content-Length", end - start + 1);
        return reply.send(createReadStream(absolutePath, { start, end }));
      }

      reply.header("Content-Length", stats.size);
      return reply.send(createReadStream(absolutePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read media file";
      if (message.includes("Unsupported media extension")) {
        reply.status(403);
      } else if (message.includes("escapes media root")) {
        reply.status(404);
      } else {
        reply.status(404);
      }
      return { error: message };
    }
  });
}

const isLoopbackIp = (input: string) => {
  const normalized = input.startsWith("::ffff:") ? input.slice(7) : input;
  return normalized === "127.0.0.1" || normalized === "::1";
};

const contentTypeByExt = (ext: string) => {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".tiff":
      return "image/tiff";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    default:
      return "application/octet-stream";
  }
};

const parseByteRange = (range: string, size: number) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= size) return null;

  return { start, end: Math.min(end, size - 1) };
};

const parseMode = (
  input: string | undefined,
  targetPath: string,
  enableLightRootMode: boolean
): FolderMode => {
  if (!input) {
    return enableLightRootMode && targetPath.trim() === "" ? "light" : "full";
  }
  if (input === "light" || input === "full") {
    return input;
  }
  throw new Error("mode must be light or full");
};

type PreviewBatchLogEntry = {
  ts: number;
  requestPathCount: number;
  successCount: number;
  failedCount: number;
  durationMs: number;
  slowestPath?: string;
  slowestMs: number;
  failures: Array<{ path: string; error: string }>;
};

const appendPreviewBatchLog = async (diagnosticsDir: string, entry: PreviewBatchLogEntry) => {
  if (!diagnosticsDir) return;
  const filePath = path.join(diagnosticsDir, "server-previews.log");
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await fs.mkdir(diagnosticsDir, { recursive: true });
    await fs.appendFile(filePath, line, "utf8");
  } catch {
    // Diagnostics logging is best-effort and should not affect API behavior.
  }
};
