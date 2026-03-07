import Fastify from "fastify";
import cors from "@fastify/cors";
import { AppConfig, isOriginAllowed } from "./config";
import { registerRoutes } from "./routes";
import { MediaScanner } from "./scanner";
import { VideoThumbnailCache } from "./video_thumbnail_cache";

export const buildServer = (appConfig: AppConfig) => {
  const fastify = Fastify({
    logger: true,
  });

  fastify.register(cors, {
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, appConfig));
    },
  });

  const scanner = new MediaScanner(
    appConfig.mediaRoot,
    appConfig.previewLimit,
    appConfig.maxItemsPerFolder,
    appConfig.folderPageLimit,
    appConfig.maxFolderPageLimit,
    appConfig.statConcurrency,
    appConfig.cacheTtlMs,
    appConfig.cacheMaxEntries,
    appConfig.cacheMaxBytes,
    appConfig.enableIndexPersist,
    appConfig.indexDir,
    appConfig.indexMaxBytes
  );
  const thumbnailCache = new VideoThumbnailCache(
    appConfig.thumbnailCacheDir,
    appConfig.ffmpegBin
  );
  void registerRoutes(fastify, scanner, thumbnailCache, appConfig);
  fastify.addHook("onClose", () => {
    scanner.close();
  });

  fastify.addHook("onReady", () => {
    fastify.log.info(
      {
        mediaRoot: appConfig.mediaRoot,
        previewLimit: appConfig.previewLimit,
        folderPageLimit: appConfig.folderPageLimit,
        previewBatchLimit: appConfig.previewBatchLimit,
        thumbnailCacheDir: appConfig.thumbnailCacheDir,
        requireLanToken: appConfig.requireLanToken,
        enableLightRootMode: appConfig.enableLightRootMode,
        enableIndexPersist: appConfig.enableIndexPersist,
      },
      "media-viewer server ready"
    );
  });

  return fastify;
};
