import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { DateTime } from 'luxon';
import { loadEnv, type Env } from '../../src/config/env.js';
import { buildApp } from '../../src/http/app.js';
import type { Clock } from '../../src/lib/clock.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { createPrisma, type PrismaClient } from '../../src/lib/prisma.js';
import { createTokenSigner } from '../../src/lib/tokens.js';
import type { MailMessage, MailTransport } from '../../src/mail/transport.js';
import { Database } from '../../src/repositories/index.js';
import { createServices, type Services } from '../../src/services/index.js';

export const PASSWORD = 'correct-horse-battery';
export const TIMEZONE = 'America/New_York';
/** A Monday, noon in New York. All scenarios are relative to this instant. */
export const NOW = new Date('2031-03-03T17:00:00Z');

export class TestClock implements Clock {
  constructor(private current: Date = NOW) {}
  now(): Date {
    return this.current;
  }
  set(value: Date): void {
    this.current = value;
  }
}

export class MemoryMail implements MailTransport {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

export interface Harness {
  app: FastifyInstance;
  prisma: PrismaClient;
  db: Database;
  services: Services;
  clock: TestClock;
  env: Env;
  close(): Promise<void>;
}

export async function createHarness(
  databaseUrl: string,
  overrides: Record<string, string> = {},
): Promise<Harness> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
    AUTH_RATE_LIMIT_MAX: '1000',
    MAIL_TRANSPORT: 'log',
    REMINDERS_ENABLED: 'false',
    ...overrides,
  });
  const prisma = createPrisma(databaseUrl);
  const db = new Database(prisma);
  const clock = new TestClock();
  const signer = createTokenSigner(env.JWT_ACCESS_SECRET, env.JWT_ACCESS_TTL_SECONDS);
  const services = createServices(db, clock, signer, {
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  });
  const app = await buildApp({ env, db, services, signer, clock });
  await app.ready();
  return {
    app,
    prisma,
    db,
    services,
    clock,
    env,
    close: async () => {
      await app.close();
      await db.disconnect();
    },
  };
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE idempotency_keys, appointments, refresh_tokens, time_off, working_hours, ' +
      'staff_services, staff_members, customers, users, services, organizations CASCADE',
  );
}

let passwordHash: Promise<string> | undefined;

export interface World {
  admin: { token: string };
  alice: { token: string; staffId: string };
  bob: { token: string; staffId: string };
  carol: { token: string; customerId: string };
  dave: { token: string; customerId: string };
  haircutId: string;
  consultId: string;
}

/** A small business: two staff, two services, two customers and an admin, Monday to Friday 09:00-17:00. */
export async function seedWorld(h: Harness): Promise<World> {
  h.clock.set(NOW);
  passwordHash ??= hashPassword(PASSWORD);
  const hash = await passwordHash;
  const { prisma } = h;

  await prisma.organization.create({
    data: {
      name: 'Test Studio',
      timezone: TIMEZONE,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
      slotGranularityMinutes: 15,
      cancellationWindowHours: 24,
      autoConfirm: true,
    },
  });
  const haircut = await prisma.service.create({
    data: { name: 'Haircut', durationMinutes: 60, bufferMinutes: 15, priceCents: 4000 },
  });
  const consult = await prisma.service.create({
    data: { name: 'Consultation', durationMinutes: 30, bufferMinutes: 0, priceCents: 2000 },
  });

  await prisma.user.create({
    data: { email: 'admin@example.com', passwordHash: hash, role: 'admin' },
  });

  const makeStaff = async (name: string, email: string, serviceIds: string[]) => {
    const user = await prisma.user.create({ data: { email, passwordHash: hash, role: 'staff' } });
    const staff = await prisma.staffMember.create({ data: { displayName: name, userId: user.id } });
    await prisma.staffService.createMany({
      data: serviceIds.map((serviceId) => ({ staffId: staff.id, serviceId })),
    });
    await prisma.workingHours.createMany({
      data: [1, 2, 3, 4, 5].map((weekday) => ({
        staffId: staff.id,
        weekday,
        startMinute: 540,
        endMinute: 1020,
      })),
    });
    return staff.id;
  };
  const aliceId = await makeStaff('Alice Example', 'alice@example.com', [haircut.id, consult.id]);
  const bobId = await makeStaff('Bob Example', 'bob@example.com', [haircut.id]);

  const makeCustomer = async (name: string, email: string) => {
    const user = await prisma.user.create({
      data: { email, passwordHash: hash, role: 'customer' },
    });
    const customer = await prisma.customer.create({ data: { name, email, userId: user.id } });
    return customer.id;
  };
  const carolId = await makeCustomer('Carol Example', 'carol@example.com');
  const daveId = await makeCustomer('Dave Example', 'dave@example.com');

  const token = async (email: string) => (await login(h.app, email)).accessToken;
  return {
    admin: { token: await token('admin@example.com') },
    alice: { token: await token('alice@example.com'), staffId: aliceId },
    bob: { token: await token('bob@example.com'), staffId: bobId },
    carol: { token: await token('carol@example.com'), customerId: carolId },
    dave: { token: await token('dave@example.com'), customerId: daveId },
    haircutId: haircut.id,
    consultId: consult.id,
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password = PASSWORD,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  return response.json<{ tokens: { accessToken: string; refreshToken: string } }>().tokens;
}

/** Instant for a local wall-clock time in the business time zone, e.g. `local('2031-03-05', '10:00')`. */
export function local(date: string, time: string, zone = TIMEZONE): string {
  const instant = DateTime.fromISO(`${date}T${time}`, { zone }).toUTC().toISO();
  if (!instant) throw new Error(`Invalid local time ${date} ${time}`);
  return instant;
}

export function request(
  h: Harness,
  token: string | undefined,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}
