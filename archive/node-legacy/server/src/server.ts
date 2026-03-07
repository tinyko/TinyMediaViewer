import { buildServer } from "./app";
import { config } from "./config";
import type { FastifyInstance } from "fastify";

async function bootstrap() {
  const fastify = buildServer(config);

  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });
    installParentWatchdog(fastify);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

bootstrap();

function installParentWatchdog(fastify: FastifyInstance) {
  const expectedParentPid = Number(process.env.TMV_PARENT_PID ?? "");
  if (!Number.isInteger(expectedParentPid) || expectedParentPid <= 1) {
    return;
  }

  const timer = setInterval(() => {
    const currentParentPid = process.ppid;
    if (currentParentPid === expectedParentPid) {
      return;
    }

    fastify.log.warn(
      {
        expectedParentPid,
        currentParentPid,
      },
      "Parent process changed, shutting down sidecar"
    );
    clearInterval(timer);
    void fastify.close().finally(() => {
      process.exit(0);
    });
  }, 5000);
  timer.unref();
}
