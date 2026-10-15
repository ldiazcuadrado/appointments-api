import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { isOverlapViolation } from '../../src/repositories/appointment.repository.js';
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

const DAY = '2031-03-05';

describe('double-booking prevention through the API', () => {
  it('lets exactly one of many simultaneous requests win a slot', async () => {
    const customers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.prisma.customer.create({
          data: { name: `Walk-in ${i}`, email: `walkin${i}@example.com` },
        }),
      ),
    );

    const responses = await Promise.all(
      customers.map((customer) =>
        request(h, w.admin.token, 'POST', '/appointments', {
          serviceId: w.haircutId,
          staffId: w.alice.staffId,
          customerId: customer.id,
          startsAt: local(DAY, '10:00'),
        }),
      ),
    );

    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    expect(await h.prisma.appointment.count()).toBe(1);
  });

  it('spreads simultaneous any-staff requests across staff without overbooking', async () => {
    const customers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        h.prisma.customer.create({
          data: { name: `Walk-in ${i}`, email: `walkin${i}@example.com` },
        }),
      ),
    );
    const responses = await Promise.all(
      customers.map((customer) =>
        request(h, w.admin.token, 'POST', '/appointments', {
          serviceId: w.haircutId,
          customerId: customer.id,
          startsAt: local(DAY, '14:00'),
        }),
      ),
    );
    // Two haircut-capable staff members exist, so two bookings succeed and the rest conflict.
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(4);
    const staffIds = (await h.prisma.appointment.findMany()).map((a) => a.staffId);
    expect(new Set(staffIds).size).toBe(2);
  });
});

describe('appointments_no_overlap exclusion constraint', () => {
  const appointment = (staffId: string, start: string, end: string, blockedUntil = end) => ({
    serviceId: w.haircutId,
    staffId,
    customerId: w.carol.customerId,
    status: 'confirmed' as const,
    startsAt: new Date(local(DAY, start)),
    endsAt: new Date(local(DAY, end)),
    blockedUntil: new Date(local(DAY, blockedUntil)),
    priceCents: 4000,
    currency: 'USD',
  });

  it('rejects concurrent inserts that bypass the application checks', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        h.prisma.appointment.create({ data: appointment(w.alice.staffId, '10:00', '11:00') }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => isOverlapViolation(r.reason))).toBe(true);
  });

  it('rejects partial overlaps and overlaps that only exist because of the buffer', async () => {
    await h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '10:00', '11:00', '11:15'),
    });

    const partial = h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '10:30', '11:30'),
    });
    await expect(partial).rejects.toSatisfy(isOverlapViolation);

    const insideBuffer = h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '11:05', '12:00'),
    });
    await expect(insideBuffer).rejects.toSatisfy(isOverlapViolation);
  });

  it('allows back-to-back ranges, other staff, and slots released by cancellation', async () => {
    const first = await h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '10:00', '11:00', '11:15'),
    });
    await h.prisma.appointment.create({ data: appointment(w.alice.staffId, '11:15', '12:00') });
    await h.prisma.appointment.create({
      data: appointment(w.bob.staffId, '10:00', '11:00', '11:15'),
    });

    await h.prisma.appointment.update({ where: { id: first.id }, data: { status: 'cancelled' } });
    await h.prisma.appointment.create({ data: appointment(w.alice.staffId, '10:00', '11:00') });
  });

  it('also guards updates', async () => {
    await h.prisma.appointment.create({ data: appointment(w.alice.staffId, '10:00', '11:00') });
    const other = await h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '13:00', '14:00'),
    });
    const move = h.prisma.appointment.update({
      where: { id: other.id },
      data: {
        startsAt: new Date(local(DAY, '10:30')),
        endsAt: new Date(local(DAY, '11:30')),
        blockedUntil: new Date(local(DAY, '11:30')),
      },
    });
    await expect(move).rejects.toSatisfy(isOverlapViolation);
  });

  it('rejects inverted ranges', async () => {
    const inverted = h.prisma.appointment.create({
      data: appointment(w.alice.staffId, '11:00', '10:00'),
    });
    await expect(inverted).rejects.toThrow();
  });
});
