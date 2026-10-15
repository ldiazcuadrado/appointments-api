import {
  computeSlots,
  parseLocalDate,
  type Slot,
  type StaffSchedule,
} from '../domain/availability.js';
import { notFound, unprocessable } from '../domain/errors.js';
import type { Interval } from '../domain/types.js';
import type { Repositories } from '../repositories/index.js';
import type { StaffWithServices } from '../repositories/staff.repository.js';
import type { ServiceDeps } from './context.js';

export interface AvailabilityRequest {
  serviceId: string;
  staffId?: string | undefined;
  from: string;
  to: string;
}

export interface AvailableSlot {
  startsAt: Date;
  endsAt: Date;
  staffIds: string[];
}

export interface AvailabilityResult {
  timezone: string;
  serviceId: string;
  slots: AvailableSlot[];
}

const PAD_MS = 86_400_000;

/** Loads everything the pure availability engine needs for a set of staff members. */
export async function loadSchedules(
  repos: Repositories,
  staff: readonly StaffWithServices[],
  window: Interval,
  excludeAppointmentId?: string,
): Promise<StaffSchedule[]> {
  const ids = staff.map((member) => member.id);
  // Pad the window so bookings and closures that straddle its edges still count.
  const padded = {
    start: new Date(window.start.getTime() - PAD_MS),
    end: new Date(window.end.getTime() + PAD_MS),
  };
  // Sequential on purpose: callers may pass a transaction-bound client, which is a single connection.
  const hours = await repos.staff.getWorkingHours(ids);
  const timeOff = await repos.staff.findBlockingTimeOff(ids, padded);
  const booked = await repos.appointments.findActiveInRange(ids, padded, excludeAppointmentId);
  return ids.map((staffId) => ({
    staffId,
    workingHours: hours.filter((h) => h.staffId === staffId),
    timeOff: timeOff
      .filter((t) => t.staffId === null || t.staffId === staffId)
      .map((t) => ({ start: t.startsAt, end: t.endsAt })),
    booked: booked
      .filter((b) => b.staffId === staffId)
      .map((b) => ({ start: b.startsAt, end: b.blockedUntil })),
  }));
}

export function dayWindow(fromDate: string, toDate: string, timezone: string): Interval {
  const start = parseLocalDate(fromDate, timezone);
  const end = parseLocalDate(toDate, timezone).plus({ days: 1 });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export class AvailabilityService {
  constructor(private readonly deps: ServiceDeps) {}

  async search(request: AvailabilityRequest): Promise<AvailabilityResult> {
    const { repos } = this.deps.db;
    const organization = await repos.organizations.get();
    if (!organization) throw notFound('Organization');
    const service = await repos.services.findById(request.serviceId);
    if (!service?.active) throw notFound('Service');

    const staff = await repos.staff.findForService(service.id, request.staffId);
    if (request.staffId && staff.length === 0) {
      throw unprocessable(
        'staff-unavailable-for-service',
        'The staff member is inactive or does not perform this service',
      );
    }

    // Validate the range before touching the database for schedules.
    const window = dayWindow(request.from, request.to, organization.timezone);
    const schedules = await loadSchedules(repos, staff, window);
    const slots = computeSlots({
      timezone: organization.timezone,
      fromDate: request.from,
      toDate: request.to,
      service,
      rules: organization,
      staff: schedules,
      now: this.deps.clock.now(),
    });
    return {
      timezone: organization.timezone,
      serviceId: service.id,
      slots: groupByStart(slots),
    };
  }
}

function groupByStart(slots: readonly Slot[]): AvailableSlot[] {
  const grouped = new Map<number, AvailableSlot>();
  for (const slot of slots) {
    const key = slot.startsAt.getTime();
    const existing = grouped.get(key);
    if (existing) existing.staffIds.push(slot.staffId);
    else
      grouped.set(key, { startsAt: slot.startsAt, endsAt: slot.endsAt, staffIds: [slot.staffId] });
  }
  return [...grouped.values()];
}
