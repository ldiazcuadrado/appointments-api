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

interface Slot {
  startsAt: string;
  endsAt: string;
  staffIds: string[];
}
interface Appointment {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  staff: { id: string };
  customer: { id: string };
}

const WEDNESDAY = '2031-03-05';

const slots = async (query: string, token = w.carol.token) =>
  (await request(h, token, 'GET', `/availability?${query}`)).json<{ slots: Slot[] }>().slots;

const book = (
  body: Record<string, unknown>,
  token = w.carol.token,
  headers: Record<string, string> = {},
) => request(h, token, 'POST', '/appointments', { serviceId: w.haircutId, ...body }, headers);

describe('availability', () => {
  it('lists grid slots inside working hours, in order', async () => {
    const result = await slots(`serviceId=${w.haircutId}&from=${WEDNESDAY}&to=${WEDNESDAY}`);
    expect(result).toHaveLength(29);
    expect(result[0]).toMatchObject({ startsAt: local(WEDNESDAY, '09:00') });
    expect(result.at(-1)?.startsAt).toBe(local(WEDNESDAY, '16:00'));
    expect(result[0]?.staffIds.sort()).toEqual([w.alice.staffId, w.bob.staffId].sort());
  });

  it('narrows to a single staff member and rejects one who does not offer the service', async () => {
    const onlyAlice = await slots(`serviceId=${w.consultId}&from=${WEDNESDAY}&to=${WEDNESDAY}`);
    expect(
      onlyAlice.every((s) => s.staffIds.length === 1 && s.staffIds[0] === w.alice.staffId),
    ).toBe(true);

    const response = await request(
      h,
      w.carol.token,
      'GET',
      `/availability?serviceId=${w.consultId}&staffId=${w.bob.staffId}&from=${WEDNESDAY}&to=${WEDNESDAY}`,
    );
    expect(response.statusCode).toBe(422);
  });

  it('returns nothing on weekends and honors the minimum notice', async () => {
    expect(await slots(`serviceId=${w.haircutId}&from=2031-03-08&to=2031-03-09`)).toEqual([]);
    const today = await slots(`serviceId=${w.haircutId}&from=2031-03-03&to=2031-03-03`);
    // 12:00 now + 120 minutes notice -> first start at 14:00 local.
    expect(today[0]?.startsAt).toBe(local('2031-03-03', '14:00'));
  });

  it('validates the range', async () => {
    const tooLong = await request(
      h,
      w.carol.token,
      'GET',
      `/availability?serviceId=${w.haircutId}&from=2031-03-01&to=2031-05-01`,
    );
    expect(tooLong.statusCode).toBe(400);
    const inverted = await request(
      h,
      w.carol.token,
      'GET',
      `/availability?serviceId=${w.haircutId}&from=2031-03-05&to=2031-03-01`,
    );
    expect(inverted.statusCode).toBe(400);
  });

  it('removes time off and organization closures', async () => {
    await request(h, w.alice.token, 'POST', '/time-off', {
      staffId: w.alice.staffId,
      startsAt: local(WEDNESDAY, '12:00'),
      endsAt: local(WEDNESDAY, '17:00'),
      reason: 'Dentist',
    });
    const alice = await slots(
      `serviceId=${w.haircutId}&staffId=${w.alice.staffId}&from=${WEDNESDAY}&to=${WEDNESDAY}`,
    );
    expect(alice.at(-1)?.startsAt).toBe(local(WEDNESDAY, '11:00'));

    await request(h, w.admin.token, 'POST', '/time-off', {
      staffId: null,
      startsAt: local(WEDNESDAY, '00:00'),
      endsAt: local('2031-03-06', '00:00'),
      reason: 'Holiday',
    });
    expect(await slots(`serviceId=${w.haircutId}&from=${WEDNESDAY}&to=${WEDNESDAY}`)).toEqual([]);
    expect(await slots(`serviceId=${w.haircutId}&from=2031-03-06&to=2031-03-06`)).not.toEqual([]);
  });

  it('computes the spring-forward day correctly end to end', async () => {
    const sunday = '2031-03-09';
    const put = await request(h, w.admin.token, 'PUT', `/staff/${w.alice.staffId}/working-hours`, {
      intervals: [{ weekday: 7, start: '01:00', end: '05:00' }],
    });
    expect(put.statusCode).toBe(200);

    const result = await slots(
      `serviceId=${w.haircutId}&staffId=${w.alice.staffId}&from=${sunday}&to=${sunday}`,
    );
    // 01:00 EST is 06:00Z; 05:00 EDT is 09:00Z; the 02:xx hour does not exist.
    expect(result[0]?.startsAt).toBe('2031-03-09T06:00:00.000Z');
    expect(result.at(-1)?.startsAt).toBe('2031-03-09T08:00:00.000Z');
    expect(result).toHaveLength(9);

    const booked = await book({ staffId: w.alice.staffId, startsAt: local(sunday, '03:00') });
    expect(booked.statusCode).toBe(201);
    expect(booked.json<Appointment>().startsAt).toBe('2031-03-09T07:00:00.000Z');
  });
});

describe('booking', () => {
  it('books a slot for a customer and takes it off the market', async () => {
    const startsAt = local(WEDNESDAY, '10:00');
    const response = await book({ staffId: w.alice.staffId, startsAt });
    expect(response.statusCode).toBe(201);
    expect(response.json<Appointment>()).toMatchObject({
      status: 'confirmed',
      startsAt,
      endsAt: local(WEDNESDAY, '11:00'),
      staff: { id: w.alice.staffId },
      customer: { id: w.carol.customerId },
    });

    const alice = (
      await slots(
        `serviceId=${w.haircutId}&staffId=${w.alice.staffId}&from=${WEDNESDAY}&to=${WEDNESDAY}`,
      )
    ).map((s) => s.startsAt);
    // 60-minute service plus 15-minute buffer blocks starts from 09:00 (would end after 10:00) to 11:00.
    expect(alice).not.toContain(local(WEDNESDAY, '09:00'));
    expect(alice).not.toContain(local(WEDNESDAY, '10:00'));
    expect(alice).not.toContain(local(WEDNESDAY, '11:00'));
    expect(alice).toContain(local(WEDNESDAY, '11:15'));
  });

  it('assigns another available staff member when no staff is requested', async () => {
    const startsAt = local(WEDNESDAY, '10:00');
    const first = await book({ startsAt });
    const second = await book({ startsAt }, w.dave.token);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(
      new Set([first.json<Appointment>().staff.id, second.json<Appointment>().staff.id]).size,
    ).toBe(2);

    const third = await book({ startsAt }, w.dave.token);
    expect(third.statusCode).toBe(409);
    expect(third.headers['content-type']).toContain('application/problem+json');
    expect(third.json()).toMatchObject({ type: 'urn:appointments-api:problem:slot-unavailable' });
  });

  it('enforces the buffer between consecutive bookings', async () => {
    await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') });
    const tooClose = await book(
      { staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '11:00') },
      w.dave.token,
    );
    expect(tooClose.statusCode).toBe(409);
    const justRight = await book(
      { staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '11:15') },
      w.dave.token,
    );
    expect(justRight.statusCode).toBe(201);
    const before = await book(
      { staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '08:45') },
      w.dave.token,
    );
    expect(before.statusCode).toBe(409);
  });

  it.each([
    ['outside working hours', WEDNESDAY, '08:00'],
    ['after closing', WEDNESDAY, '16:30'],
    ['on a weekend', '2031-03-08', '10:00'],
    ['off the slot grid', WEDNESDAY, '10:07'],
    ['inside the minimum notice', '2031-03-03', '13:00'],
    ['beyond the booking horizon', '2031-08-06', '10:00'],
  ])('rejects a start %s', async (_name, date, time) => {
    const response = await book({ staffId: w.alice.staffId, startsAt: local(date, time) });
    expect(response.statusCode).toBe(409);
  });

  it('rejects unknown or inactive services and bad payloads', async () => {
    const unknown = await book({
      serviceId: crypto.randomUUID(),
      startsAt: local(WEDNESDAY, '10:00'),
    });
    expect(unknown.statusCode).toBe(404);

    await request(h, w.admin.token, 'PATCH', `/services/${w.haircutId}`, { active: false });
    const inactive = await book({ startsAt: local(WEDNESDAY, '10:00') });
    expect(inactive.statusCode).toBe(404);

    const malformed = await request(h, w.carol.token, 'POST', '/appointments', {
      serviceId: 'x',
      startsAt: 'tomorrow',
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('lets staff book on behalf of a customer but not customers on behalf of others', async () => {
    const startsAt = local(WEDNESDAY, '10:00');
    const forOther = await book({ startsAt, customerId: w.dave.customerId });
    expect(forOther.statusCode).toBe(403);

    const missing = await book({ startsAt }, w.alice.token);
    expect(missing.statusCode).toBe(400);

    const byStaff = await book(
      { startsAt, customerId: w.dave.customerId, staffId: w.alice.staffId },
      w.alice.token,
    );
    expect(byStaff.statusCode).toBe(201);
    expect(byStaff.json<Appointment>().customer.id).toBe(w.dave.customerId);
  });

  it('creates pending appointments when auto-confirm is off, until staff confirm them', async () => {
    await request(h, w.admin.token, 'PATCH', '/organization', { autoConfirm: false });
    const created = await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') });
    expect(created.json<Appointment>().status).toBe('pending');

    const forbidden = await request(
      h,
      w.carol.token,
      'POST',
      `/appointments/${created.json<Appointment>().id}/status`,
      { status: 'confirmed' },
    );
    expect(forbidden.statusCode).toBe(403);
    const confirmed = await request(
      h,
      w.alice.token,
      'POST',
      `/appointments/${created.json<Appointment>().id}/status`,
      { status: 'confirmed' },
    );
    expect(confirmed.json<Appointment>().status).toBe('confirmed');
  });
});

describe('idempotency', () => {
  const body = () => ({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') });

  it('replays the original appointment for a repeated key', async () => {
    const first = await book(body(), w.carol.token, { 'idempotency-key': 'key-1' });
    const second = await book(body(), w.carol.token, { 'idempotency-key': 'key-1' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.json<Appointment>().id).toBe(first.json<Appointment>().id);
    expect(await h.prisma.appointment.count()).toBe(1);
  });

  it('rejects a key reused with a different request', async () => {
    await book(body(), w.carol.token, { 'idempotency-key': 'key-2' });
    const reused = await book({ ...body(), startsAt: local(WEDNESDAY, '14:00') }, w.carol.token, {
      'idempotency-key': 'key-2',
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({
      type: 'urn:appointments-api:problem:idempotency-key-reuse',
    });
  });

  it('scopes keys to the caller', async () => {
    await book(body(), w.carol.token, { 'idempotency-key': 'shared' });
    const other = await book({ ...body(), startsAt: local(WEDNESDAY, '14:00') }, w.dave.token, {
      'idempotency-key': 'shared',
    });
    expect(other.statusCode).toBe(201);
  });

  it('without a key a repeated request is a conflict', async () => {
    await book(body());
    expect((await book(body())).statusCode).toBe(409);
  });

  it('collapses concurrent retries with the same key into one appointment', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => book(body(), w.carol.token, { 'idempotency-key': 'burst' })),
    );
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(await h.prisma.appointment.count()).toBe(1);
  });
});

describe('reading appointments', () => {
  it('scopes lists by role and supports filters and pagination', async () => {
    await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') });
    await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '13:00') });
    await book({ staffId: w.bob.staffId, startsAt: local(WEDNESDAY, '10:00') }, w.dave.token);

    const list = async (token: string, query = '') =>
      (await request(h, token, 'GET', `/appointments${query}`)).json<{
        data: Appointment[];
        meta: { total: number; totalPages: number; page: number };
      }>();

    expect((await list(w.carol.token)).meta.total).toBe(2);
    expect((await list(w.dave.token)).meta.total).toBe(1);
    expect((await list(w.alice.token)).meta.total).toBe(2);
    expect((await list(w.bob.token)).meta.total).toBe(1);
    expect((await list(w.admin.token)).meta.total).toBe(3);

    const paged = await list(w.admin.token, '?pageSize=2&page=2');
    expect(paged.data).toHaveLength(1);
    expect(paged.meta).toMatchObject({ page: 2, totalPages: 2, total: 3 });

    const filtered = await list(
      w.admin.token,
      `?staffId=${w.bob.staffId}&status=confirmed&from=${encodeURIComponent(local(WEDNESDAY, '00:00'))}&to=${encodeURIComponent(local('2031-03-06', '00:00'))}`,
    );
    expect(filtered.meta.total).toBe(1);
    expect((await list(w.admin.token, '?status=cancelled')).meta.total).toBe(0);
    expect((await request(h, w.admin.token, 'GET', '/appointments?pageSize=500')).statusCode).toBe(
      400,
    );
  });

  it('hides appointments from unrelated users', async () => {
    const created = (
      await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') })
    ).json<Appointment>();
    expect((await request(h, w.carol.token, 'GET', `/appointments/${created.id}`)).statusCode).toBe(
      200,
    );
    expect((await request(h, w.alice.token, 'GET', `/appointments/${created.id}`)).statusCode).toBe(
      200,
    );
    expect((await request(h, w.dave.token, 'GET', `/appointments/${created.id}`)).statusCode).toBe(
      403,
    );
    expect((await request(h, w.bob.token, 'GET', `/appointments/${created.id}`)).statusCode).toBe(
      403,
    );
    expect(
      (await request(h, w.admin.token, 'GET', `/appointments/${crypto.randomUUID()}`)).statusCode,
    ).toBe(404);
  });

  it('serves an iCalendar file', async () => {
    const created = (
      await book({ staffId: w.alice.staffId, startsAt: local(WEDNESDAY, '10:00') })
    ).json<Appointment>();
    const response = await request(h, w.carol.token, 'GET', `/appointments/${created.id}/ics`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/calendar');
    expect(response.headers['content-disposition']).toContain('.ics');
    expect(response.body).toContain('BEGIN:VEVENT');
    expect(response.body).toContain('DTSTART:20310305T150000Z');
    expect(response.body).toContain('SUMMARY:Haircut at Test Studio');
    expect(
      (await request(h, w.dave.token, 'GET', `/appointments/${created.id}/ics`)).statusCode,
    ).toBe(403);
  });
});

describe('schedules', () => {
  it('validates working hours', async () => {
    const overlapping = await request(
      h,
      w.admin.token,
      'PUT',
      `/staff/${w.alice.staffId}/working-hours`,
      {
        intervals: [
          { weekday: 1, start: '09:00', end: '12:00' },
          { weekday: 1, start: '11:00', end: '14:00' },
        ],
      },
    );
    expect(overlapping.statusCode).toBe(400);
    const malformed = await request(
      h,
      w.admin.token,
      'PUT',
      `/staff/${w.alice.staffId}/working-hours`,
      {
        intervals: [{ weekday: 1, start: '9am', end: '12:00' }],
      },
    );
    expect(malformed.statusCode).toBe(400);
    const empty = await request(
      h,
      w.admin.token,
      'PUT',
      `/staff/${w.alice.staffId}/working-hours`,
      { intervals: [] },
    );
    expect(empty.json()).toEqual([]);
  });

  it('lets staff edit only their own schedule', async () => {
    const intervals = [{ weekday: 1, start: '10:00', end: '12:00' }];
    expect(
      (
        await request(h, w.alice.token, 'PUT', `/staff/${w.alice.staffId}/working-hours`, {
          intervals,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await request(h, w.alice.token, 'PUT', `/staff/${w.bob.staffId}/working-hours`, {
          intervals,
        })
      ).statusCode,
    ).toBe(403);
    const read = await request(h, w.carol.token, 'GET', `/staff/${w.alice.staffId}/working-hours`);
    expect(read.json()).toEqual([{ weekday: 1, start: '10:00', end: '12:00' }]);
  });
});
