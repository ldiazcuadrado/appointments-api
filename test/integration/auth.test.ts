import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  login,
  PASSWORD,
  request,
  resetDatabase,
  seedWorld,
  type Harness,
} from '../helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness(inject('databaseUrl'));
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma);
  await seedWorld(h);
});

const register = (email: string, password = PASSWORD) =>
  request(h, undefined, 'POST', '/auth/register', { email, password, name: 'New Customer' });

describe('registration and login', () => {
  it('registers a customer and returns a working session', async () => {
    const response = await register('New@Example.com');
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      user: { email: string; role: string; customerId: string };
      tokens: { accessToken: string };
    }>();
    expect(body.user).toMatchObject({ email: 'new@example.com', role: 'customer' });
    expect(body.user.customerId).toBeTruthy();

    const me = await request(h, body.tokens.accessToken, 'GET', '/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json<{ email: string }>().email).toBe('new@example.com');
  });

  it('never stores the password in clear text', async () => {
    await register('hash@example.com');
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email: 'hash@example.com' } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it('rejects a duplicate email with a conflict problem', async () => {
    const response = await register('carol@example.com');
    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 409,
      type: 'urn:appointments-api:problem:email-taken',
    });
  });

  it('links a walk-in customer record when its owner registers', async () => {
    const walkIn = await h.prisma.customer.create({
      data: { name: 'Walk In', email: 'walkin@example.com' },
    });
    const response = await register('walkin@example.com');
    expect(response.statusCode).toBe(201);
    expect(response.json<{ user: { customerId: string } }>().user.customerId).toBe(walkIn.id);
  });

  it('rejects weak or malformed input with field-level errors', async () => {
    const response = await register('not-an-email', 'short');
    expect(response.statusCode).toBe(400);
    const body = response.json<{ errors: { path: string }[]; requestId: string }>();
    expect(body.errors.map((e) => e.path).sort()).toEqual(['email', 'password']);
    expect(body.requestId).toBeTruthy();
  });

  it('logs in with valid credentials and rejects invalid ones identically', async () => {
    const ok = await request(h, undefined, 'POST', '/auth/login', {
      email: 'carol@example.com',
      password: PASSWORD,
    });
    expect(ok.statusCode).toBe(200);
    const wrongPassword = await request(h, undefined, 'POST', '/auth/login', {
      email: 'carol@example.com',
      password: 'wrong-password',
    });
    const unknownUser = await request(h, undefined, 'POST', '/auth/login', {
      email: 'ghost@example.com',
      password: PASSWORD,
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json<{ detail: string }>().detail).toBe(
      unknownUser.json<{ detail: string }>().detail,
    );
  });
});

describe('access tokens', () => {
  it('requires a bearer token', async () => {
    const response = await request(h, undefined, 'GET', '/auth/me');
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects garbage and tampered tokens', async () => {
    expect((await request(h, 'garbage', 'GET', '/auth/me')).statusCode).toBe(401);
    const { accessToken } = await login(h.app, 'carol@example.com');
    const tampered = `${accessToken.slice(0, -3)}abc`;
    expect((await request(h, tampered, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('echoes a supplied request id and generates one otherwise', async () => {
    const supplied = await h.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'trace-123' },
    });
    expect(supplied.headers['x-request-id']).toBe('trace-123');
    const generated = await h.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('refresh tokens', () => {
  it('rotates the token and invalidates the previous one', async () => {
    const first = await login(h.app, 'carol@example.com');
    const rotated = await request(h, undefined, 'POST', '/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json<{ refreshToken: string; accessToken: string }>();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await request(h, second.accessToken, 'GET', '/auth/me')).statusCode).toBe(200);
  });

  it('revokes the whole session when a rotated token is replayed', async () => {
    const first = await login(h.app, 'carol@example.com');
    const rotated = await request(h, undefined, 'POST', '/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    const second = rotated.json<{ refreshToken: string }>();

    const replay = await request(h, undefined, 'POST', '/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    expect(replay.statusCode).toBe(401);
    const afterReplay = await request(h, undefined, 'POST', '/auth/refresh', {
      refreshToken: second.refreshToken,
    });
    expect(afterReplay.statusCode).toBe(401);
  });

  it('rejects unknown and expired tokens', async () => {
    expect(
      (await request(h, undefined, 'POST', '/auth/refresh', { refreshToken: 'nope' })).statusCode,
    ).toBe(401);
    const { refreshToken } = await login(h.app, 'carol@example.com');
    await h.prisma.refreshToken.updateMany({ data: { expiresAt: new Date('2000-01-01') } });
    expect(
      (await request(h, undefined, 'POST', '/auth/refresh', { refreshToken })).statusCode,
    ).toBe(401);
  });

  it('logout revokes the session', async () => {
    const { refreshToken } = await login(h.app, 'carol@example.com');
    expect((await request(h, undefined, 'POST', '/auth/logout', { refreshToken })).statusCode).toBe(
      204,
    );
    expect(
      (await request(h, undefined, 'POST', '/auth/refresh', { refreshToken })).statusCode,
    ).toBe(401);
  });
});

describe('rate limiting', () => {
  it('throttles auth routes with a problem response', async () => {
    const limited = await createHarness(inject('databaseUrl'), { AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request(limited, undefined, 'POST', '/auth/login', {
          email: 'x@example.com',
          password: 'whatever1',
        });
        statuses.push(response.statusCode);
        if (response.statusCode === 429) {
          expect(response.headers['retry-after']).toBeDefined();
          expect(response.json()).toMatchObject({
            status: 429,
            type: 'urn:appointments-api:problem:rate-limited',
          });
        }
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
