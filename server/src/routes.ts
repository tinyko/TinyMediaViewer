import { FastifyInstance } from "fastify";
import { MediaScanner } from "./scanner";

export async function registerRoutes(
  fastify: FastifyInstance,
  scanner: MediaScanner
) {
  fastify.get("/health", async () => ({ status: "ok" }));

  fastify.get(
    "/api/folder",
    async (request, reply): Promise<unknown> => {
      const query = request.query as { path?: string };
      const targetPath = query.path ?? "";

      try {
        const payload = await scanner.getFolder(targetPath);
        return payload;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to read folder";
        reply.status(400);
        return { error: message };
      }
    }
  );
}
