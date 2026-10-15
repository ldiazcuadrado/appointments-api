import { DateTime } from 'luxon';
import { buildIcs } from '../domain/ics.js';
import type { MailMessage } from './transport.js';

export interface ReminderDetails {
  appointmentId: string;
  customerEmail: string;
  customerName: string;
  serviceName: string;
  staffName: string;
  businessName: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  status: 'pending' | 'confirmed';
  now: Date;
}

export function buildReminderMessage(details: ReminderDetails): MailMessage {
  const when = DateTime.fromJSDate(details.startsAt, { zone: details.timezone })
    .setLocale('en')
    .toFormat("cccc, d LLLL yyyy 'at' HH:mm (ZZZZ)");
  const subject = `Reminder: ${details.serviceName} on ${DateTime.fromJSDate(details.startsAt, {
    zone: details.timezone,
  }).toFormat('d LLL, HH:mm')}`;
  const text = [
    `Hello ${details.customerName},`,
    '',
    `This is a reminder of your upcoming appointment at ${details.businessName}.`,
    '',
    `Service: ${details.serviceName}`,
    `With:    ${details.staffName}`,
    `When:    ${when}`,
    '',
    'A calendar file is attached. If you can no longer attend, please cancel in advance.',
  ].join('\n');

  const ics = buildIcs({
    uid: `${details.appointmentId}@appointments-api`,
    startsAt: details.startsAt,
    endsAt: details.endsAt,
    summary: `${details.serviceName} at ${details.businessName}`,
    description: `With ${details.staffName}`,
    status: details.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE',
    stamp: details.now,
  });

  return {
    to: details.customerEmail,
    subject,
    text,
    attachments: [{ filename: 'appointment.ics', content: ics, contentType: 'text/calendar' }],
  };
}
