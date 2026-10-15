import { describe, expect, it } from 'vitest';
import {
  computeSlots,
  isValidTimezone,
  localDateOf,
  MAX_RANGE_DAYS,
  slotsStartingAt,
  type AvailabilityQuery,
  type StaffSchedule,
} from '../../src/domain/availability.js';
import { DomainError } from '../../src/domain/errors.js';
import type { Interval } from '../../src/domain/types.js';

const NOW = new Date('2025-01-01T00:00:00Z');

const weekdays = (startMinute: number, endMinute: number, days = [1, 2, 3, 4, 5, 6, 7]) =>
  days.map((weekday) => ({ weekday, startMinute, endMinute }));

const range = (start: string, end: string): Interval => ({
  start: new Date(start),
  end: new Date(end),
});

function schedule(overrides: Partial<StaffSchedule> = {}): StaffSchedule {
  return {
    staffId: 'a',
    workingHours: weekdays(9 * 60, 17 * 60),
    timeOff: [],
    booked: [],
    ...overrides,
  };
}

function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    timezone: 'UTC',
    fromDate: '2025-06-02',
    toDate: '2025-06-02',
    service: { durationMinutes: 60, bufferMinutes: 0 },
    rules: { minNoticeMinutes: 0, maxAdvanceDays: 365, slotGranularityMinutes: 30 },
    staff: [schedule()],
    now: NOW,
    ...overrides,
  };
}

const starts = (q: AvailabilityQuery) =>
  computeSlots(q).map((s) => s.startsAt.toISOString().slice(11, 16));

describe('computeSlots', () => {
  it('lists every grid start whose service fits inside the working interval', () => {
    const result = starts(query());
    expect(result).toHaveLength(15);
    expect(result[0]).toBe('09:00');
    expect(result.at(-1)).toBe('16:00');
  });

  it('returns slots with the service duration', () => {
    const [slot] = computeSlots(query({ service: { durationMinutes: 45, bufferMinutes: 0 } }));
    expect(slot).toBeDefined();
    expect((slot?.endsAt.getTime() ?? 0) - (slot?.startsAt.getTime() ?? 0)).toBe(45 * 60_000);
  });

  it('aligns the first slot to the granularity grid', () => {
    const q = query({
      staff: [schedule({ workingHours: weekdays(9 * 60 + 10, 12 * 60) })],
      rules: { minNoticeMinutes: 0, maxAdvanceDays: 365, slotGranularityMinutes: 15 },
    });
    expect(starts(q)[0]).toBe('09:15');
  });

  it('returns nothing on days without working hours', () => {
    const q = query({
      staff: [schedule({ workingHours: weekdays(540, 1020, [1]) })],
      fromDate: '2025-06-03',
      toDate: '2025-06-03',
    });
    expect(computeSlots(q)).toEqual([]);
  });

  it('supports split days such as a lunch break', () => {
    const q = query({
      staff: [
        schedule({
          workingHours: [
            { weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
            { weekday: 1, startMinute: 14 * 60, endMinute: 16 * 60 },
          ],
        }),
      ],
    });
    expect(starts(q)).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '14:00',
      '14:30',
      '15:00',
    ]);
  });

  it('blocks starts that overlap an existing booking and its buffer', () => {
    const q = query({
      service: { durationMinutes: 60, bufferMinutes: 15 },
      staff: [schedule({ booked: [range('2025-06-02T10:00:00Z', '2025-06-02T11:15:00Z')] })],
    });
    const result = starts(q);
    expect(result).not.toContain('09:30');
    expect(result).not.toContain('09:00');
    expect(result).not.toContain('11:00');
    expect(result).toContain('11:30');
  });

  it('lets a new booking start exactly where the previous block ends', () => {
    const q = query({
      staff: [schedule({ booked: [range('2025-06-02T09:00:00Z', '2025-06-02T10:00:00Z')] })],
    });
    expect(starts(q)[0]).toBe('10:00');
  });

  it('keeps a slot whose own buffer would end after the working hours', () => {
    const q = query({ service: { durationMinutes: 60, bufferMinutes: 30 } });
    expect(starts(q).at(-1)).toBe('16:00');
  });

  it('excludes slots overlapping time off, which does not apply the buffer', () => {
    const q = query({
      service: { durationMinutes: 60, bufferMinutes: 30 },
      staff: [schedule({ timeOff: [range('2025-06-02T12:00:00Z', '2025-06-02T13:00:00Z')] })],
    });
    const result = starts(q);
    expect(result).not.toContain('11:30');
    expect(result).not.toContain('12:30');
    expect(result).toContain('11:00');
    expect(result).toContain('13:00');
  });

  it('honors the minimum notice', () => {
    const q = query({
      now: new Date('2025-06-02T08:00:00Z'),
      rules: { minNoticeMinutes: 120, maxAdvanceDays: 365, slotGranularityMinutes: 30 },
    });
    expect(starts(q)[0]).toBe('10:00');
  });

  it('honors the maximum advance window', () => {
    const q = query({
      now: new Date('2025-05-30T12:00:00Z'),
      rules: { minNoticeMinutes: 0, maxAdvanceDays: 3, slotGranularityMinutes: 60 },
      toDate: '2025-06-05',
    });
    const last = computeSlots(q).at(-1);
    expect(last?.startsAt.toISOString()).toBe('2025-06-02T12:00:00.000Z');
  });

  it('merges multiple staff members in start order', () => {
    const q = query({
      staff: [
        schedule({ staffId: 'b', workingHours: weekdays(10 * 60, 11 * 60) }),
        schedule({ staffId: 'a', workingHours: weekdays(10 * 60, 11 * 60) }),
      ],
    });
    expect(computeSlots(q).map((s) => s.staffId)).toEqual(['a', 'b']);
  });

  it('interprets working hours in the organization time zone', () => {
    const q = query({ timezone: 'Europe/Madrid' });
    expect(computeSlots(q)[0]?.startsAt.toISOString()).toBe('2025-06-02T07:00:00.000Z');
  });

  it('handles zones with a half-hour offset', () => {
    const q = query({ timezone: 'Asia/Kolkata' });
    expect(computeSlots(q)[0]?.startsAt.toISOString()).toBe('2025-06-02T03:30:00.000Z');
  });

  describe('daylight saving time', () => {
    const fullDay = (date: string, timezone: string) =>
      query({
        timezone,
        fromDate: date,
        toDate: date,
        service: { durationMinutes: 60, bufferMinutes: 0 },
        rules: { minNoticeMinutes: 0, maxAdvanceDays: 3650, slotGranularityMinutes: 60 },
        staff: [schedule({ workingHours: weekdays(0, 1440) })],
      });

    it('skips the hour that does not exist on the spring-forward day', () => {
      const q = fullDay('2025-03-09', 'America/New_York');
      expect(computeSlots(q)).toHaveLength(23);
      const local = computeSlots({
        ...q,
        staff: [schedule({ workingHours: weekdays(0, 6 * 60) })],
      });
      expect(local.map((s) => s.startsAt.toISOString().slice(11, 13))).toEqual([
        '05',
        '06',
        '07',
        '08',
        '09',
      ]);
    });

    it('offers both occurrences of the repeated hour on the fall-back day', () => {
      const q = fullDay('2025-11-02', 'America/New_York');
      expect(computeSlots(q)).toHaveLength(25);
      const local = computeSlots({
        ...q,
        staff: [schedule({ workingHours: weekdays(0, 4 * 60) })],
      });
      expect(local.map((s) => s.startsAt.toISOString().slice(11, 13))).toEqual([
        '04',
        '05',
        '06',
        '07',
        '08',
      ]);
    });

    it('keeps wall-clock working hours stable across the transition', () => {
      const before = computeSlots({
        ...query({ timezone: 'Europe/Madrid' }),
        fromDate: '2025-03-29',
        toDate: '2025-03-29',
      });
      const after = computeSlots({
        ...query({ timezone: 'Europe/Madrid' }),
        fromDate: '2025-03-31',
        toDate: '2025-03-31',
      });
      expect(before[0]?.startsAt.toISOString()).toBe('2025-03-29T08:00:00.000Z');
      expect(after[0]?.startsAt.toISOString()).toBe('2025-03-31T07:00:00.000Z');
    });

    it('checks conflicts in absolute time across the repeated hour', () => {
      const q = fullDay('2025-11-02', 'America/New_York');
      const first = '2025-11-02T05:00:00Z';
      const withBooking: AvailabilityQuery = {
        ...q,
        staff: [
          schedule({
            workingHours: weekdays(0, 4 * 60),
            booked: [range(first, '2025-11-02T06:00:00Z')],
          }),
        ],
      };
      const result = computeSlots(withBooking).map((s) => s.startsAt.toISOString().slice(11, 13));
      expect(result).toEqual(['04', '06', '07', '08']);
    });

    it('resolves an ambiguous working-hours start to its first occurrence', () => {
      const q = query({
        timezone: 'America/New_York',
        fromDate: '2025-11-02',
        toDate: '2025-11-02',
        rules: { minNoticeMinutes: 0, maxAdvanceDays: 3650, slotGranularityMinutes: 60 },
        staff: [schedule({ workingHours: weekdays(60, 3 * 60) })],
      });
      expect(computeSlots(q).map((s) => s.startsAt.toISOString().slice(11, 13))).toEqual([
        '05',
        '06',
        '07',
      ]);
    });

    it('resolves a start inside the spring-forward gap to the next valid instant', () => {
      const q = query({
        timezone: 'America/New_York',
        fromDate: '2025-03-09',
        toDate: '2025-03-09',
        rules: { minNoticeMinutes: 0, maxAdvanceDays: 3650, slotGranularityMinutes: 30 },
        staff: [schedule({ workingHours: weekdays(2 * 60 + 30, 5 * 60) })],
      });
      expect(computeSlots(q)[0]?.startsAt.toISOString()).toBe('2025-03-09T07:30:00.000Z');
    });
  });

  describe('validation', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof DomainError ? error.code : 'other';
      }
      return 'none';
    };

    it('rejects an unknown time zone', () => {
      expect(code(() => computeSlots(query({ timezone: 'Mars/Olympus' })))).toBe(
        'invalid-timezone',
      );
    });

    it('rejects malformed dates', () => {
      expect(code(() => computeSlots(query({ fromDate: '2025-13-40' })))).toBe('invalid-date');
      expect(code(() => computeSlots(query({ fromDate: '2025-6-2' })))).toBe('invalid-date');
    });

    it('rejects an inverted range', () => {
      expect(
        code(() => computeSlots(query({ fromDate: '2025-06-03', toDate: '2025-06-02' }))),
      ).toBe('invalid-range');
    });

    it('rejects ranges longer than the maximum', () => {
      expect(MAX_RANGE_DAYS).toBe(31);
      expect(
        code(() => computeSlots(query({ fromDate: '2025-06-01', toDate: '2025-07-02' }))),
      ).toBe('range-too-large');
      expect(
        code(() => computeSlots(query({ fromDate: '2025-06-01', toDate: '2025-07-01' }))),
      ).toBe('none');
    });
  });
});

describe('slotsStartingAt', () => {
  it('returns one candidate per staff member free at that instant', () => {
    const {
      fromDate: _from,
      toDate: _to,
      ...base
    } = query({
      staff: [
        schedule({ staffId: 'a' }),
        schedule({ staffId: 'b', booked: [range('2025-06-02T10:00:00Z', '2025-06-02T11:00:00Z')] }),
      ],
    });
    const found = slotsStartingAt(base, new Date('2025-06-02T10:00:00Z'));
    expect(found.map((s) => s.staffId)).toEqual(['a']);
    expect(slotsStartingAt(base, new Date('2025-06-02T10:10:00Z'))).toEqual([]);
  });
});

describe('time zone helpers', () => {
  it('validates zone names', () => {
    expect(isValidTimezone('Europe/Madrid')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });

  it('derives the local date of an instant', () => {
    const instant = new Date('2025-06-02T23:30:00Z');
    expect(localDateOf(instant, 'UTC')).toBe('2025-06-02');
    expect(localDateOf(instant, 'Asia/Tokyo')).toBe('2025-06-03');
    expect(localDateOf(instant, 'America/Los_Angeles')).toBe('2025-06-02');
  });
});
