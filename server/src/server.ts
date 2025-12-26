import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "path";
import { config } from "./config";
import { MediaScanner } from "./scanner";
import { registerRoutes } from "./routes";

async function bootstrap() {
  const fastify = Fastify({
    logger: true,
  });

  fastify.register(cors, { origin: true });
  fastify.register(fastifyStatic, {
    root: config.mediaRoot,
    prefix: "/media/",
    decorateReply: false,
    cacheControl: true,
    maxAge: 1000 * 60 * 60 * 24,
  });

  const scanner = new MediaScanner(
    config.mediaRoot,
    config.previewLimit,
    config.maxItemsPerFolder
  );
  await registerRoutes(fastify, scanner);

  fastify.addHook("onReady", () => {
    fastify.log.info(
      { mediaRoot: config.mediaRoot, previewLimit: config.previewLimit },
      "media-viewer server ready"
    );
  });

  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

bootstrap();
