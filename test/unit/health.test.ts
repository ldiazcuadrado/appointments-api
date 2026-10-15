import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { healthRoutes } from '../../src/http/routes/health.js';
import type { Database } from '../../src/repositories/index.js';

async function appWith(ping: () => Promise<void>) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRoutes, { db: { ping } as unknown as Database });
  return app;
}

describe('readiness probe', () => {
  it('is ready while the database answers', async () => {
    const app = await appWith(() => Promise.resolve());
    const response = await app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(200);
  });

  it('turns unavailable when the database does not', async () => {
    const app = await appWith(() => Promise.reject(new Error('down')));
    const response = await app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  });
});
