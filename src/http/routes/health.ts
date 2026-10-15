import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../repositories/index.js';

export const healthRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (app, { db }) => {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe; checks the database connection',
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: z.object({ status: z.literal('unavailable') }),
        },
      },
    },
    async (request, reply) => {
      try {
        await db.ping();
        return { status: 'ready' as const };
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        return reply.status(503).send({ status: 'unavailable' as const });
      }
    },
  );
};
