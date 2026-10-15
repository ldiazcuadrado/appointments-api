import { PgBoss } from 'pg-boss';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { ReminderService } from '../services/reminder.service.js';

const SWEEP_QUEUE = 'reminder-sweep';
const SEND_QUEUE = 'reminder-send';

export interface ReminderWorker {
  /** Enqueues a send job; used by the sweep and exposed for the service wiring. */
  enqueue(appointmentId: string): Promise<void>;
  start(service: ReminderService): Promise<void>;
  stop(): Promise<void>;
}

export function createReminderWorker(connectionString: string, logger: Logger): ReminderWorker {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error');
  });

  return {
    async enqueue(appointmentId) {
      // The singleton key makes repeated sweeps idempotent while a job is still pending.
      await boss.send(
        SEND_QUEUE,
        { appointmentId },
        { singletonKey: appointmentId, retryLimit: 5, retryDelay: 30, retryBackoff: true },
      );
    },

    async start(service) {
      await boss.start();
      await boss.createQueue(SWEEP_QUEUE);
      await boss.createQueue(SEND_QUEUE);

      await boss.work<object>(SWEEP_QUEUE, async () => {
        const queued = await service.enqueueDue();
        if (queued > 0) logger.info({ queued }, 'reminders queued');
      });
      await boss.work<{ appointmentId: string }>(SEND_QUEUE, async (jobs) => {
        for (const job of jobs) {
          const outcome = await service.send(job.data.appointmentId);
          logger.info({ appointmentId: job.data.appointmentId, outcome }, 'reminder processed');
        }
      });
      await boss.schedule(SWEEP_QUEUE, '* * * * *');
    },

    stop: () => boss.stop({ graceful: true, timeout: 10_000 }),
  };
}
