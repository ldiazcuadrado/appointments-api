import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  local,
  request,
  resetDatabase,
  seedWorld,
  type Harness,
  type World,
} from '../helpers/harness.js';

let h: Harness;
let w: World;

beforeAll(async () => {
  h = await createHarness(inject('databaseUrl'));
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma);
  w = await seedWorld(h);
});

type Role = 'anonymous' | 'customer' | 'staff' | 'admin';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Case {
  name: string;
  method: Method;
  url: (w: World) => string;
  body?: (w: World) => unknown;
  /** Roles that must get past authorization; every other role must be refused. */
  allowed: Role[];
}

const everyone: Role[] = ['customer', 'staff', 'admin'];
const staffSide: Role[] = ['staff', 'admin'];

const cases: Case[] = [
  { name: 'read organization', method: 'GET', url: () => '/organization', allowed: everyone },
  {
    name: 'update organization',
    method: 'PATCH',
    url: () => '/organization',
    body: () => ({ name: 'Renamed' }),
    allowed: ['admin'],
  },
  { name: 'list services', method: 'GET', url: () => '/services', allowed: everyone },
  {
    name: 'create service',
    method: 'POST',
    url: () => '/services',
    body: () => ({ name: 'Colour', durationMinutes: 90, priceCents: 9000 }),
    allowed: ['admin'],
  },
  {
    name: 'update service',
    method: 'PATCH',
    url: (w) => `/services/${w.haircutId}`,
    body: () => ({ priceCents: 5000 }),
    allowed: ['admin'],
  },
  { name: 'list staff', method: 'GET', url: () => '/staff', allowed: everyone },
  {
    name: 'create staff',
    method: 'POST',
    url: () => '/staff',
    body: () => ({
      displayName: 'Eve Example',
      email: 'eve@example.com',
      password: 'correct-horse-battery',
    }),
    allowed: ['admin'],
  },
  {
    name: 'update staff',
    method: 'PATCH',
    url: (w) => `/staff/${w.bob.staffId}`,
    body: () => ({ active: true }),
    allowed: ['admin'],
  },
  {
    name: 'assign services',
    method: 'PUT',
    url: (w) => `/staff/${w.bob.staffId}/services`,
    body: (w) => ({ serviceIds: [w.haircutId] }),
    allowed: ['admin'],
  },
  { name: 'list customers', method: 'GET', url: () => '/customers', allowed: staffSide },
  {
    name: 'create customer',
    method: 'POST',
    url: () => '/customers',
    body: () => ({ name: 'Walk In', email: 'walkin@example.com' }),
    allowed: staffSide,
  },
  { name: 'list time off', method: 'GET', url: () => '/time-off', allowed: staffSide },
  {
    name: 'create organization-wide closure',
    method: 'POST',
    url: () => '/time-off',
    body: () => ({
      staffId: null,
      startsAt: local('2031-04-01', '00:00'),
      endsAt: local('2031-04-02', '00:00'),
    }),
    allowed: ['admin'],
  },
  {
    name: 'search availability',
    method: 'GET',
    url: (w) => `/availability?serviceId=${w.haircutId}&from=2031-03-05&to=2031-03-05`,
    allowed: everyone,
  },
  { name: 'list appointments', method: 'GET', url: () => '/appointments', allowed: everyone },
];

const tokenFor = (role: Role): string | undefined =>
  ({ anonymous: undefined, customer: w.carol.token, staff: w.alice.token, admin: w.admin.token })[
    role
  ];

describe('route authorization matrix', () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      for (const role of ['anonymous', 'customer', 'staff', 'admin'] as const) {
        const response = await request(
          h,
          tokenFor(role),
          testCase.method,
          testCase.url(w),
          testCase.body?.(w),
        );
        if (testCase.allowed.includes(role)) {
          expect([401, 403], `${role} should be allowed`).not.toContain(response.statusCode);
        } else {
          expect(response.statusCode, `${role} should be refused`).toBe(
            role === 'anonymous' ? 401 : 403,
          );
        }
      }
    });
  }
});

describe('ownership rules', () => {
  it('lets a customer read and edit only their own record, and never their email', async () => {
    expect(
      (await request(h, w.carol.token, 'GET', `/customers/${w.carol.customerId}`)).statusCode,
    ).toBe(200);
    expect(
      (await request(h, w.carol.token, 'GET', `/customers/${w.dave.customerId}`)).statusCode,
    ).toBe(403);

    const rename = await request(h, w.carol.token, 'PATCH', `/customers/${w.carol.customerId}`, {
      name: 'Carol Renamed',
    });
    expect(rename.statusCode).toBe(200);
    const changeEmail = await request(
      h,
      w.carol.token,
      'PATCH',
      `/customers/${w.carol.customerId}`,
      { email: 'other@example.com' },
    );
    expect(changeEmail.statusCode).toBe(403);
    const editOther = await request(h, w.carol.token, 'PATCH', `/customers/${w.dave.customerId}`, {
      name: 'Nope',
    });
    expect(editOther.statusCode).toBe(403);
    expect(
      (
        await request(h, w.alice.token, 'PATCH', `/customers/${w.dave.customerId}`, {
          phone: '555-0100',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('keeps staff time off personal', async () => {
    const window = { startsAt: local('2031-04-01', '09:00'), endsAt: local('2031-04-01', '12:00') };
    const own = await request(h, w.alice.token, 'POST', '/time-off', {
      staffId: w.alice.staffId,
      ...window,
    });
    expect(own.statusCode).toBe(201);
    const others = await request(h, w.alice.token, 'POST', '/time-off', {
      staffId: w.bob.staffId,
      ...window,
    });
    expect(others.statusCode).toBe(403);

    const id = own.json<{ id: string }>().id;
    expect((await request(h, w.bob.token, 'DELETE', `/time-off/${id}`)).statusCode).toBe(403);
    expect((await request(h, w.carol.token, 'DELETE', `/time-off/${id}`)).statusCode).toBe(403);
    expect((await request(h, w.alice.token, 'DELETE', `/time-off/${id}`)).statusCode).toBe(204);
    expect((await request(h, w.alice.token, 'DELETE', `/time-off/${id}`)).statusCode).toBe(404);
  });

  it('hides inactive services and staff from non-admins', async () => {
    await request(h, w.admin.token, 'PATCH', `/services/${w.consultId}`, { active: false });
    await request(h, w.admin.token, 'PATCH', `/staff/${w.bob.staffId}`, { active: false });

    const names = async (token: string, path: string) =>
      (await request(h, token, 'GET', `${path}includeInactive=true`)).json<{ data: unknown[] }>()
        .data.length;
    expect(await names(w.carol.token, '/services?')).toBe(1);
    expect(await names(w.admin.token, '/services?')).toBe(2);
    expect(await names(w.carol.token, '/staff?')).toBe(1);
    expect(await names(w.admin.token, '/staff?')).toBe(2);
  });

  it('rejects a token whose account was removed', async () => {
    await h.prisma.user.delete({ where: { email: 'carol@example.com' } });
    expect((await request(h, w.carol.token, 'GET', '/appointments')).statusCode).toBe(401);
  });
});
