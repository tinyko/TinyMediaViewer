import { buildServer } from "./app";
import { config } from "./config";

async function bootstrap() {
  const fastify = buildServer(config);

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
