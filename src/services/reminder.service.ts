import { notFound } from '../domain/errors.js';
import { isActive } from '../domain/booking-rules.js';
import type { MailTransport } from '../mail/transport.js';
import { buildReminderMessage } from '../mail/templates.js';
import type { ServiceDeps } from './context.js';

export type ReminderOutcome = 'sent' | 'skipped';

export interface ReminderOptions {
  leadHours: number;
  enqueue: (appointmentId: string) => Promise<void>;
}

export class ReminderService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly mail: MailTransport,
    private readonly options: ReminderOptions,
  ) {}

  /** Queues a send job for every active appointment that starts within the lead time and has no reminder yet. */
  async enqueueDue(): Promise<number> {
    const now = this.deps.clock.now();
    const due = await this.deps.db.repos.appointments.findDueForReminder({
      start: now,
      end: new Date(now.getTime() + this.options.leadHours * 3_600_000),
    });
    for (const appointment of due) await this.options.enqueue(appointment.id);
    return due.length;
  }

  async send(appointmentId: string): Promise<ReminderOutcome> {
    const { repos } = this.deps.db;
    const now = this.deps.clock.now();
    const appointment = await repos.appointments.findById(appointmentId);
    if (!appointment) return 'skipped';
    if (
      !isActive(appointment.status) ||
      appointment.reminderSentAt ||
      appointment.startsAt <= now
    ) {
      return 'skipped';
    }
    const organization = await repos.organizations.get();
    if (!organization) throw notFound('Organization');

    await this.mail.send(
      buildReminderMessage({
        appointmentId: appointment.id,
        customerEmail: appointment.customer.email,
        customerName: appointment.customer.name,
        serviceName: appointment.service.name,
        staffName: appointment.staff.displayName,
        businessName: organization.name,
        timezone: organization.timezone,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status === 'confirmed' ? 'confirmed' : 'pending',
        now,
      }),
    );
    await repos.appointments.markReminderSent(appointment.id, now);
    return 'sent';
  }
}
