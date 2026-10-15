import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createReminderWorker } from '../../src/jobs/reminders.js';
import { ReminderService } from '../../src/services/reminder.service.js';
import {
  createHarness,
  local,
  MemoryMail,
  request,
  resetDatabase,
  seedWorld,
  type Harness,
  type World,
} from '../helpers/harness.js';

let h: Harness;
let w: World;
let mail: MemoryMail;
let queued: string[];
let reminders: ReminderService;

beforeAll(async () => {
  h = await createHarness(inject('databaseUrl'));
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma);
  w = await seedWorld(h);
  mail = new MemoryMail();
  queued = [];
  reminders = new ReminderService({ db: h.db, clock: h.clock }, mail, {
    leadHours: 24,
    enqueue: (id) => {
      queued.push(id);
      return Promise.resolve();
    },
  });
});

async function book(date: string, time: string, token = w.carol.token): Promise<string> {
  const response = await request(h, token, 'POST', '/appointments', {
    serviceId: w.haircutId,
    staffId: w.alice.staffId,
    startsAt: local(date, time),
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

describe('reminder sweep', () => {
  it('queues only active appointments starting within the lead time', async () => {
    // Now is Monday 12:00 local. Tuesday 10:00 is 22 hours away; Thursday is not due.
    const soon = await book('2031-03-04', '10:00');
    await book('2031-03-06', '10:00');
    const cancelled = await book('2031-03-04', '13:00', w.dave.token);
    await request(h, w.admin.token, 'POST', `/appointments/${cancelled}/cancel`, {});

    expect(await reminders.enqueueDue()).toBe(1);
    expect(queued).toEqual([soon]);
  });
});

describe('reminder delivery', () => {
  it('emails the customer once, with a calendar attachment', async () => {
    const id = await book('2031-03-04', '10:00');

    expect(await reminders.send(id)).toBe('sent');
    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message?.to).toBe('carol@example.com');
    expect(message?.subject).toContain('Haircut');
    expect(message?.text).toContain('Tuesday, 4 March 2031 at 10:00');
    expect(message?.attachments?.[0]).toMatchObject({
      filename: 'appointment.ics',
      contentType: 'text/calendar',
    });
    expect(message?.attachments?.[0]?.content).toContain('DTSTART:20310304T150000Z');

    expect(await reminders.send(id)).toBe('skipped');
    expect(mail.sent).toHaveLength(1);
    expect(await reminders.enqueueDue()).toBe(0);
  });

  it('skips appointments that were cancelled or already started', async () => {
    const cancelled = await book('2031-03-04', '10:00');
    await request(h, w.admin.token, 'POST', `/appointments/${cancelled}/cancel`, {});
    expect(await reminders.send(cancelled)).toBe('skipped');

    const started = await book('2031-03-04', '13:00', w.dave.token);
    h.clock.set(new Date(local('2031-03-04', '13:30')));
    expect(await reminders.send(started)).toBe('skipped');
    expect(await reminders.send(crypto.randomUUID())).toBe('skipped');
    expect(mail.sent).toHaveLength(0);
  });

  it('sends a fresh reminder after the appointment is rescheduled', async () => {
    const id = await book('2031-03-04', '10:00');
    await reminders.send(id);
    await request(h, w.admin.token, 'POST', `/appointments/${id}/reschedule`, {
      startsAt: local('2031-03-04', '15:00'),
    });
    expect(await reminders.send(id)).toBe('sent');
    expect(mail.sent).toHaveLength(2);
  });
});

describe('pg-boss worker', () => {
  it('delivers a queued reminder through the job queue', async () => {
    const id = await book('2031-03-04', '10:00');
    const worker = createReminderWorker(inject('databaseUrl'), pino({ level: 'silent' }));
    const service = new ReminderService({ db: h.db, clock: h.clock }, mail, {
      leadHours: 24,
      enqueue: (appointmentId) => worker.enqueue(appointmentId),
    });
    await worker.start(service);
    try {
      await worker.enqueue(id);
      await expect.poll(() => mail.sent.length, { timeout: 20_000, interval: 250 }).toBe(1);
      expect(mail.sent[0]?.to).toBe('carol@example.com');
    } finally {
      await worker.stop();
    }
  });
});
