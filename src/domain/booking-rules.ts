import { DateTime } from 'luxon';
import { conflict, invalid, unprocessable } from './errors.js';
import type { AppointmentStatus, Role, ServiceTiming, WorkingInterval } from './types.js';

const TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'completed', 'no_show'],
  cancelled: [],
  completed: [],
  no_show: [],
};

const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed'];

export const isActive = (status: AppointmentStatus): boolean => ACTIVE_STATUSES.includes(status);

export function assertTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
  startsAt: Date,
  now: Date,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw conflict('invalid-status-transition', `An appointment cannot go from ${from} to ${to}`);
  }
  if ((to === 'completed' || to === 'no_show') && now < startsAt) {
    throw unprocessable(
      'appointment-not-started',
      `An appointment cannot be marked ${to} before it starts`,
    );
  }
}

export interface ChangeRequest {
  actorRole: Role;
  status: AppointmentStatus;
  startsAt: Date;
  now: Date;
  cancellationWindowHours: number;
}

/**
 * Customers may only cancel or reschedule until the cancellation window opens
 * (a fixed number of hours before the start). Staff and admins are exempt.
 */
function assertChangeAllowed(request: ChangeRequest, action: 'cancel' | 'reschedule'): void {
  if (!isActive(request.status)) {
    throw conflict('appointment-not-active', `A ${request.status} appointment cannot be changed`);
  }
  if (request.now >= request.startsAt) {
    throw unprocessable('appointment-started', 'The appointment has already started');
  }
  if (request.actorRole !== 'customer') return;
  const deadline = DateTime.fromJSDate(request.startsAt).minus({
    hours: request.cancellationWindowHours,
  });
  if (DateTime.fromJSDate(request.now) > deadline) {
    throw unprocessable(
      'cancellation-window-closed',
      `Appointments can only be ${action === 'cancel' ? 'cancelled' : 'rescheduled'} ` +
        `at least ${request.cancellationWindowHours} hours in advance`,
    );
  }
}

export const assertCancellable = (request: ChangeRequest): void =>
  assertChangeAllowed(request, 'cancel');

export const assertReschedulable = (request: ChangeRequest): void =>
  assertChangeAllowed(request, 'reschedule');

export function blockedUntil(startsAt: Date, service: ServiceTiming): Date {
  return new Date(startsAt.getTime() + (service.durationMinutes + service.bufferMinutes) * 60_000);
}

export function endsAt(startsAt: Date, service: ServiceTiming): Date {
  return new Date(startsAt.getTime() + service.durationMinutes * 60_000);
}

/** Rejects malformed or overlapping weekly schedules. */
export function assertValidWorkingHours(intervals: readonly WorkingInterval[]): void {
  for (const i of intervals) {
    if (i.weekday < 1 || i.weekday > 7) {
      throw invalid('invalid-working-hours', 'weekday must be between 1 and 7');
    }
    if (i.startMinute < 0 || i.endMinute > 1440 || i.startMinute >= i.endMinute) {
      throw invalid(
        'invalid-working-hours',
        'Each interval needs 0 <= startMinute < endMinute <= 1440',
      );
    }
  }
  const sorted = [...intervals].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;
    if (previous.weekday === current.weekday && current.startMinute < previous.endMinute) {
      throw invalid('invalid-working-hours', 'Working intervals on the same weekday overlap');
    }
  }
}

export function minutesToClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function clockToMinutes(clock: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw invalid('invalid-time', `"${clock}" is not a valid HH:mm time`);
  }
  return hours * 60 + minutes;
}
