import type { HealthResponse } from '@s-maker/shared';
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply): Promise<HealthResponse | undefined> => {
    try {
      app.db.prepare('SELECT 1').get();
    } catch {
      reply.status(503).send({ status: 'error' });
      return;
    }
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok', version: app.config.version };
  });
}
