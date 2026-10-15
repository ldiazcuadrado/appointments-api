import { loadEnv } from './config/env.js';
import { buildApp } from './http/app.js';
import { createReminderWorker } from './jobs/reminders.js';
import { systemClock } from './lib/clock.js';
import { createTokenSigner } from './lib/tokens.js';
import { createPrisma } from './lib/prisma.js';
import { createLogTransport, createSmtpTransport } from './mail/transport.js';
import { Database } from './repositories/index.js';
import { createServices } from './services/index.js';
import { ReminderService } from './services/reminder.service.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const db = new Database(createPrisma(env.DATABASE_URL));
  const signer = createTokenSigner(env.JWT_ACCESS_SECRET, env.JWT_ACCESS_TTL_SECONDS);
  const services = createServices(db, systemClock, signer, {
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  });

  const app = await buildApp({
    env,
    db,
    services,
    signer,
    clock: systemClock,
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
        : {}),
    },
  });

  const mail =
    env.MAIL_TRANSPORT === 'smtp'
      ? createSmtpTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          user: env.SMTP_USER,
          password: env.SMTP_PASSWORD,
          from: env.MAIL_FROM,
        })
      : createLogTransport(app.log);

  const worker = env.REMINDERS_ENABLED
    ? createReminderWorker(env.DATABASE_URL, app.log)
    : undefined;

  app.addHook('onClose', async () => {
    await worker?.stop();
    await mail.close?.();
    await db.disconnect();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, 15_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: env.HOST, port: env.PORT });

  if (worker) {
    const reminders = new ReminderService({ db, clock: systemClock }, mail, {
      leadHours: env.REMINDER_LEAD_HOURS,
      enqueue: (id) => worker.enqueue(id),
    });
    await worker.start(reminders);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
