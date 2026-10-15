import { DateTime } from 'luxon';
import { invalid } from './errors.js';
import type { BookingRules, Interval, ServiceTiming, WorkingInterval } from './types.js';

export const MAX_RANGE_DAYS = 31;
const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

export interface StaffSchedule {
  staffId: string;
  workingHours: readonly WorkingInterval[];
  /** Time off covering this staff member, including organization-wide closures. */
  timeOff: readonly Interval[];
  /** Ranges already claimed by active appointments, buffer included. */
  booked: readonly Interval[];
}

export interface Slot {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityQuery {
  timezone: string;
  /** Inclusive local dates, `YYYY-MM-DD`, in the organization time zone. */
  fromDate: string;
  toDate: string;
  service: ServiceTiming;
  rules: BookingRules;
  staff: readonly StaffSchedule[];
  now: Date;
}

export function isValidTimezone(timezone: string): boolean {
  return DateTime.now().setZone(timezone).isValid;
}

export function parseLocalDate(value: string, timezone: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid('invalid-date', `"${value}" is not a valid YYYY-MM-DD date`);
  }
  return parsed.startOf('day');
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in the given zone. */
export function localDateOf(instant: Date, timezone: string): string {
  const iso = DateTime.fromJSDate(instant, { zone: timezone }).toISODate();
  if (iso === null) throw invalid('invalid-timezone', `Unknown time zone "${timezone}"`);
  return iso;
}

/**
 * Resolves a wall-clock minute-of-day on a local day to an instant. Minute 1440
 * means the following local midnight. A wall-clock time skipped by a DST gap
 * resolves forward; an ambiguous one resolves to its first occurrence.
 */
function instantAt(dayStart: DateTime, minuteOfDay: number): number {
  if (minuteOfDay >= MINUTES_PER_DAY) return dayStart.plus({ days: 1 }).startOf('day').toMillis();
  return dayStart
    .set({
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
      millisecond: 0,
    })
    .toMillis();
}

function overlaps(intervals: readonly Interval[], start: number, end: number): boolean {
  return intervals.some((i) => i.start.getTime() < end && start < i.end.getTime());
}

/**
 * Computes every bookable start time in the requested date range.
 *
 * Candidate starts sit on a wall-clock grid (multiples of the granularity from
 * local midnight) inside each working interval, then advance in elapsed time,
 * so a day with a DST transition yields exactly the slots that physically fit.
 * A slot is kept when the service fits inside the working interval, clears the
 * minimum notice and the booking horizon, does not touch time off, and its
 * duration plus buffer does not overlap an existing booking.
 */
export function computeSlots(query: AvailabilityQuery): Slot[] {
  const { timezone, service, rules, now } = query;
  if (!isValidTimezone(timezone)) {
    throw invalid('invalid-timezone', `Unknown time zone "${timezone}"`);
  }

  const first = parseLocalDate(query.fromDate, timezone);
  const last = parseLocalDate(query.toDate, timezone);
  const dayCount = Math.round(last.diff(first, 'days').days) + 1;
  if (dayCount < 1) throw invalid('invalid-range', '"to" must not be before "from"');
  if (dayCount > MAX_RANGE_DAYS) {
    throw invalid('range-too-large', `The date range may span at most ${MAX_RANGE_DAYS} days`);
  }

  const granularity = rules.slotGranularityMinutes;
  const stepMs = granularity * MS_PER_MINUTE;
  const durationMs = service.durationMinutes * MS_PER_MINUTE;
  const blockMs = durationMs + service.bufferMinutes * MS_PER_MINUTE;
  const earliest = now.getTime() + rules.minNoticeMinutes * MS_PER_MINUTE;
  const latest = DateTime.fromJSDate(now, { zone: timezone })
    .plus({ days: rules.maxAdvanceDays })
    .toMillis();

  const slots: Slot[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const day = first.plus({ days: offset }).startOf('day');
    for (const staff of query.staff) {
      const intervals = staff.workingHours
        .filter((h) => h.weekday === day.weekday)
        .sort((a, b) => a.startMinute - b.startMinute);
      for (const interval of intervals) {
        const windowEnd = instantAt(day, interval.endMinute);
        const firstMinute = Math.ceil(interval.startMinute / granularity) * granularity;
        for (let t = instantAt(day, firstMinute); t + durationMs <= windowEnd; t += stepMs) {
          if (t > latest) break;
          if (t < earliest) continue;
          if (overlaps(staff.timeOff, t, t + durationMs)) continue;
          if (overlaps(staff.booked, t, t + blockMs)) continue;
          slots.push({
            staffId: staff.staffId,
            startsAt: new Date(t),
            endsAt: new Date(t + durationMs),
          });
        }
      }
    }
  }
  return slots.sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.staffId.localeCompare(b.staffId),
  );
}

/** Returns the slot starting exactly at `startsAt` for one of the given staff, if it is bookable. */
export function slotsStartingAt(
  query: Omit<AvailabilityQuery, 'fromDate' | 'toDate'>,
  startsAt: Date,
): Slot[] {
  const date = localDateOf(startsAt, query.timezone);
  return computeSlots({ ...query, fromDate: date, toDate: date }).filter(
    (slot) => slot.startsAt.getTime() === startsAt.getTime(),
  );
}
