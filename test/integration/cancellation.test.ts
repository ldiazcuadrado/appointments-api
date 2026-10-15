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

interface Appointment {
  id: string;
  status: string;
  startsAt: string;
  staff: { id: string };
  cancellationReason: string | null;
}

// Wednesday 10:00 local; the cancellation window is 24 hours.
const START = () => local('2031-03-05', '10:00');

async function bookWednesday(token = w.carol.token): Promise<Appointment> {
  const response = await request(h, token, 'POST', '/appointments', {
    serviceId: w.haircutId,
    staffId: w.alice.staffId,
    startsAt: START(),
  });
  expect(response.statusCode).toBe(201);
  return response.json<Appointment>();
}

const at = (date: string, time: string) => h.clock.set(new Date(local(date, time)));
const cancel = (token: string, id: string, body: object = {}) =>
  request(h, token, 'POST', `/appointments/${id}/cancel`, body);
const problemType = (response: { json: () => unknown }) =>
  (response.json() as { type: string }).type;

describe('cancellation window', () => {
  it('lets a customer cancel before the window and records the reason', async () => {
    const appointment = await bookWednesday();
    const response = await cancel(w.carol.token, appointment.id, { reason: 'Travelling' });
    expect(response.statusCode).toBe(200);
    expect(response.json<Appointment>()).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Travelling',
    });
  });

  it('allows a customer to cancel exactly 24 hours ahead but not a minute later', async () => {
    const appointment = await bookWednesday();
    at('2031-03-04', '10:00');
    expect(problemType(await cancel(w.dave.token, appointment.id))).toContain('forbidden');

    at('2031-03-04', '10:01');
    const late = await cancel(w.carol.token, appointment.id);
    expect(late.statusCode).toBe(422);
    expect(problemType(late)).toBe('urn:appointments-api:problem:cancellation-window-closed');

    at('2031-03-04', '10:00');
    expect((await cancel(w.carol.token, appointment.id)).statusCode).toBe(200);
  });

  it('lets staff and admins cancel inside the window, but not after the start', async () => {
    const first = await bookWednesday();
    at('2031-03-05', '08:00');
    expect((await cancel(w.alice.token, first.id)).statusCode).toBe(200);

    h.clock.set(new Date('2031-03-03T17:00:00Z'));
    const second = await bookWednesday(w.dave.token);
    at('2031-03-05', '09:30');
    expect((await cancel(w.admin.token, second.id)).statusCode).toBe(200);

    h.clock.set(new Date('2031-03-03T17:00:00Z'));
    const third = await bookWednesday();
    at('2031-03-05', '10:05');
    const started = await cancel(w.admin.token, third.id);
    expect(started.statusCode).toBe(422);
    expect(problemType(started)).toBe('urn:appointments-api:problem:appointment-started');
  });

  it('frees the slot for someone else and rejects a second cancellation', async () => {
    const appointment = await bookWednesday();
    await cancel(w.carol.token, appointment.id);
    const retaken = await bookWednesday(w.dave.token);
    expect(retaken.id).not.toBe(appointment.id);

    const again = await cancel(w.carol.token, appointment.id);
    expect(again.statusCode).toBe(409);
    expect(problemType(again)).toBe('urn:appointments-api:problem:appointment-not-active');
  });

  it('reports a cancelled appointment as CANCELLED in its calendar file', async () => {
    const appointment = await bookWednesday();
    await cancel(w.carol.token, appointment.id);
    const ics = await request(h, w.carol.token, 'GET', `/appointments/${appointment.id}/ics`);
    expect(ics.body).toContain('STATUS:CANCELLED');
  });
});

describe('rescheduling', () => {
  const reschedule = (token: string, id: string, body: object) =>
    request(h, token, 'POST', `/appointments/${id}/reschedule`, body);

  it('moves an appointment and releases the old slot', async () => {
    const appointment = await bookWednesday();
    const moved = await reschedule(w.carol.token, appointment.id, {
      startsAt: local('2031-03-06', '15:00'),
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<Appointment>()).toMatchObject({
      id: appointment.id,
      startsAt: local('2031-03-06', '15:00'),
      status: 'confirmed',
    });

    const reuse = await request(h, w.dave.token, 'POST', '/appointments', {
      serviceId: w.haircutId,
      staffId: w.alice.staffId,
      startsAt: START(),
    });
    expect(reuse.statusCode).toBe(201);
  });

  it('treats a move that overlaps its own current slot as valid', async () => {
    const appointment = await bookWednesday();
    const nudged = await reschedule(w.carol.token, appointment.id, {
      startsAt: local('2031-03-05', '10:30'),
    });
    expect(nudged.statusCode).toBe(200);
  });

  it('refuses a taken slot and leaves the appointment untouched', async () => {
    const appointment = await bookWednesday();
    await request(h, w.dave.token, 'POST', '/appointments', {
      serviceId: w.haircutId,
      staffId: w.alice.staffId,
      startsAt: local('2031-03-06', '15:00'),
    });
    const conflict = await reschedule(w.carol.token, appointment.id, {
      startsAt: local('2031-03-06', '15:00'),
    });
    expect(conflict.statusCode).toBe(409);
    const unchanged = await request(h, w.carol.token, 'GET', `/appointments/${appointment.id}`);
    expect(unchanged.json<Appointment>().startsAt).toBe(START());
  });

  it('applies the cancellation window to customers only', async () => {
    const appointment = await bookWednesday();
    at('2031-03-05', '08:00');
    const customer = await reschedule(w.carol.token, appointment.id, {
      startsAt: local('2031-03-06', '15:00'),
    });
    expect(customer.statusCode).toBe(422);
    const staff = await reschedule(w.alice.token, appointment.id, {
      startsAt: local('2031-03-06', '15:00'),
    });
    expect(staff.statusCode).toBe(200);
  });

  it('lets only staff and admins reassign the staff member', async () => {
    const appointment = await bookWednesday();
    const denied = await reschedule(w.carol.token, appointment.id, {
      startsAt: START(),
      staffId: w.bob.staffId,
    });
    expect(denied.statusCode).toBe(403);
    const reassigned = await reschedule(w.admin.token, appointment.id, {
      startsAt: START(),
      staffId: w.bob.staffId,
    });
    expect(reassigned.statusCode).toBe(200);
    expect(reassigned.json<Appointment>().staff.id).toBe(w.bob.staffId);
  });

  it('does not reschedule cancelled appointments', async () => {
    const appointment = await bookWednesday();
    await cancel(w.carol.token, appointment.id);
    const response = await reschedule(w.carol.token, appointment.id, {
      startsAt: local('2031-03-06', '15:00'),
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('status transitions', () => {
  const setStatus = (token: string, id: string, status: string) =>
    request(h, token, 'POST', `/appointments/${id}/status`, { status });

  it('completes an appointment only after it started', async () => {
    const appointment = await bookWednesday();
    const early = await setStatus(w.alice.token, appointment.id, 'completed');
    expect(early.statusCode).toBe(422);

    at('2031-03-05', '11:30');
    const done = await setStatus(w.alice.token, appointment.id, 'completed');
    expect(done.json<Appointment>().status).toBe('completed');
  });

  it('records no-shows and treats terminal states as final', async () => {
    const appointment = await bookWednesday();
    at('2031-03-05', '11:30');
    expect((await setStatus(w.alice.token, appointment.id, 'no_show')).statusCode).toBe(200);
    expect((await setStatus(w.alice.token, appointment.id, 'completed')).statusCode).toBe(409);
    expect((await cancel(w.admin.token, appointment.id)).statusCode).toBe(409);
  });

  it('restricts status changes to the staff member who owns the appointment', async () => {
    const appointment = await bookWednesday();
    at('2031-03-05', '11:30');
    expect((await setStatus(w.bob.token, appointment.id, 'completed')).statusCode).toBe(403);
    expect((await setStatus(w.carol.token, appointment.id, 'completed')).statusCode).toBe(403);
    expect((await setStatus(w.admin.token, appointment.id, 'completed')).statusCode).toBe(200);
  });
});
