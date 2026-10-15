import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  request,
  resetDatabase,
  seedWorld,
  type Harness,
} from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness(inject('databaseUrl'), { CORS_ORIGINS: 'https://app.example.com' });
});
afterAll(async () => {
  await h.close();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await request(h, undefined, 'GET', '/health/live')).json()).toEqual({ status: 'ok' });
    expect((await request(h, undefined, 'GET', '/health/ready')).json()).toEqual({
      status: 'ready',
    });
  });
});

describe('problem details', () => {
  it('answers unknown routes with application/problem+json', async () => {
    const response = await request(h, undefined, 'GET', '/nope');
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: 'urn:appointments-api:problem:not-found',
      title: 'Not Found',
      status: 404,
      instance: '/nope',
      requestId: response.headers['x-request-id'],
    });
  });

  it('rejects malformed JSON as a client error', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('does not leak internals on unexpected failures', async () => {
    const original = h.db.repos.users.findByEmail.bind(h.db.repos.users);
    h.db.repos.users.findByEmail = () =>
      Promise.reject(new Error('connection string postgres://secret'));
    try {
      const response = await request(h, undefined, 'POST', '/auth/login', {
        email: 'a@example.com',
        password: 'password1',
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret');
      expect(response.json()).toMatchObject({
        type: 'urn:appointments-api:problem:internal-error',
      });
    } finally {
      h.db.repos.users.findByEmail = original;
    }
  });
});

describe('http hardening', () => {
  it('sets security headers', async () => {
    const response = await request(h, undefined, 'GET', '/health/live');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows configured CORS origins only', async () => {
    const allowed = await h.app.inject({
      method: 'OPTIONS',
      url: '/appointments',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await h.app.inject({
      method: 'OPTIONS',
      url: '/appointments',
      headers: { origin: 'https://evil.example.net', 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('serves a spec generated from the route schemas', async () => {
    const response = await request(h, undefined, 'GET', '/docs/json');
    expect(response.statusCode).toBe(200);
    const spec = response.json<{
      openapi: string;
      paths: Record<string, Record<string, { security?: unknown }>>;
      components: { securitySchemes: object };
    }>();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/appointments',
        '/appointments/{id}/cancel',
        '/availability',
        '/auth/login',
      ]),
    );
    expect(spec.paths['/appointments']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('serves the Swagger UI', async () => {
    const response = await request(h, undefined, 'GET', '/docs/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });
});

describe('organization settings', () => {
  it('rejects an unknown time zone', async () => {
    await resetDatabase(h.prisma);
    const world = await seedWorld(h);
    const response = await request(h, world.admin.token, 'PATCH', '/organization', {
      timezone: 'Mars/Olympus',
    });
    expect(response.statusCode).toBe(400);
    const ok = await request(h, world.admin.token, 'PATCH', '/organization', {
      timezone: 'Europe/Madrid',
      cancellationWindowHours: 48,
    });
    expect(ok.json()).toMatchObject({ timezone: 'Europe/Madrid', cancellationWindowHours: 48 });
  });
});
