import Fastify from "fastify";
import cors from "@fastify/cors";
import { AppConfig, isOriginAllowed } from "./config";
import { registerRoutes } from "./routes";
import { MediaScanner } from "./scanner";

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
  void registerRoutes(fastify, scanner, appConfig);

  fastify.addHook("onReady", () => {
    fastify.log.info(
      {
        mediaRoot: appConfig.mediaRoot,
        previewLimit: appConfig.previewLimit,
        folderPageLimit: appConfig.folderPageLimit,
        previewBatchLimit: appConfig.previewBatchLimit,
        requireLanToken: appConfig.requireLanToken,
        enableLightRootMode: appConfig.enableLightRootMode,
        enableIndexPersist: appConfig.enableIndexPersist,
      },
      "media-viewer server ready"
    );
  });

  return fastify;
};
