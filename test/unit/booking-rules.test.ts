import { describe, expect, it } from 'vitest';
import {
  assertCancellable,
  assertReschedulable,
  assertTransition,
  assertValidWorkingHours,
  blockedUntil,
  clockToMinutes,
  endsAt,
  isActive,
  minutesToClock,
  type ChangeRequest,
} from '../../src/domain/booking-rules.js';
import { DomainError } from '../../src/domain/errors.js';
import { APPOINTMENT_STATUSES } from '../../src/domain/types.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
};

const startsAt = new Date('2025-06-10T12:00:00Z');

function change(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    actorRole: 'customer',
    status: 'confirmed',
    startsAt,
    now: new Date('2025-06-08T12:00:00Z'),
    cancellationWindowHours: 24,
    ...overrides,
  };
}

describe('status transitions', () => {
  const now = new Date('2025-06-10T13:00:00Z');

  it('allows the documented transitions', () => {
    expect(codeOf(() => assertTransition('pending', 'confirmed', startsAt, now))).toBeUndefined();
    expect(codeOf(() => assertTransition('confirmed', 'completed', startsAt, now))).toBeUndefined();
    expect(codeOf(() => assertTransition('confirmed', 'no_show', startsAt, now))).toBeUndefined();
    expect(codeOf(() => assertTransition('confirmed', 'cancelled', startsAt, now))).toBeUndefined();
  });

  it('treats cancelled, completed and no_show as terminal', () => {
    for (const from of ['cancelled', 'completed', 'no_show'] as const) {
      for (const to of APPOINTMENT_STATUSES) {
        expect(codeOf(() => assertTransition(from, to, startsAt, now))).toBe(
          'invalid-status-transition',
        );
      }
    }
  });

  it('does not let a pending appointment complete', () => {
    expect(codeOf(() => assertTransition('pending', 'completed', startsAt, now))).toBe(
      'invalid-status-transition',
    );
  });

  it('refuses completion before the appointment starts', () => {
    const early = new Date('2025-06-10T11:59:00Z');
    expect(codeOf(() => assertTransition('confirmed', 'completed', startsAt, early))).toBe(
      'appointment-not-started',
    );
    expect(codeOf(() => assertTransition('confirmed', 'no_show', startsAt, early))).toBe(
      'appointment-not-started',
    );
  });

  it('knows which statuses hold a slot', () => {
    expect(isActive('pending')).toBe(true);
    expect(isActive('confirmed')).toBe(true);
    expect(isActive('cancelled')).toBe(false);
  });
});

describe('cancellation and rescheduling', () => {
  it('lets a customer cancel before the window opens', () => {
    expect(codeOf(() => assertCancellable(change()))).toBeUndefined();
    expect(codeOf(() => assertReschedulable(change()))).toBeUndefined();
  });

  it('lets a customer cancel exactly at the window boundary', () => {
    const now = new Date('2025-06-09T12:00:00Z');
    expect(codeOf(() => assertCancellable(change({ now })))).toBeUndefined();
  });

  it('blocks a customer inside the window', () => {
    const now = new Date('2025-06-09T12:00:01Z');
    expect(codeOf(() => assertCancellable(change({ now })))).toBe('cancellation-window-closed');
    expect(codeOf(() => assertReschedulable(change({ now })))).toBe('cancellation-window-closed');
  });

  it('exempts staff and admins from the window', () => {
    const now = new Date('2025-06-10T11:00:00Z');
    expect(codeOf(() => assertCancellable(change({ now, actorRole: 'staff' })))).toBeUndefined();
    expect(codeOf(() => assertCancellable(change({ now, actorRole: 'admin' })))).toBeUndefined();
  });

  it('blocks everyone once the appointment has started', () => {
    const now = new Date('2025-06-10T12:00:00Z');
    expect(codeOf(() => assertCancellable(change({ now, actorRole: 'admin' })))).toBe(
      'appointment-started',
    );
  });

  it('only changes active appointments', () => {
    expect(codeOf(() => assertCancellable(change({ status: 'cancelled' })))).toBe(
      'appointment-not-active',
    );
    expect(codeOf(() => assertReschedulable(change({ status: 'completed' })))).toBe(
      'appointment-not-active',
    );
  });
});

describe('time arithmetic', () => {
  const service = { durationMinutes: 45, bufferMinutes: 15 };

  it('computes the end and the blocked range of an appointment', () => {
    expect(endsAt(startsAt, service).toISOString()).toBe('2025-06-10T12:45:00.000Z');
    expect(blockedUntil(startsAt, service).toISOString()).toBe('2025-06-10T13:00:00.000Z');
  });

  it('converts clock strings to minutes and back', () => {
    expect(clockToMinutes('09:30')).toBe(570);
    expect(clockToMinutes('24:00')).toBe(1440);
    expect(minutesToClock(570)).toBe('09:30');
    expect(minutesToClock(1440)).toBe('24:00');
  });

  it('rejects malformed clock strings', () => {
    for (const bad of ['9:30', '25:00', '24:01', '10:60', 'noon', '']) {
      expect(codeOf(() => clockToMinutes(bad))).toBe('invalid-time');
    }
  });
});

describe('assertValidWorkingHours', () => {
  const ok = [
    { weekday: 1, startMinute: 540, endMinute: 720 },
    { weekday: 1, startMinute: 780, endMinute: 1020 },
    { weekday: 2, startMinute: 540, endMinute: 1020 },
  ];

  it('accepts disjoint intervals', () => {
    expect(codeOf(() => assertValidWorkingHours(ok))).toBeUndefined();
    expect(codeOf(() => assertValidWorkingHours([]))).toBeUndefined();
  });

  it('accepts back-to-back intervals', () => {
    const touching = [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 720, endMinute: 900 },
    ];
    expect(codeOf(() => assertValidWorkingHours(touching))).toBeUndefined();
  });

  it('rejects overlap on the same weekday', () => {
    const overlap = [...ok, { weekday: 1, startMinute: 700, endMinute: 800 }];
    expect(codeOf(() => assertValidWorkingHours(overlap))).toBe('invalid-working-hours');
  });

  it('rejects bad weekdays and ranges', () => {
    for (const bad of [
      { weekday: 0, startMinute: 0, endMinute: 60 },
      { weekday: 8, startMinute: 0, endMinute: 60 },
      { weekday: 1, startMinute: 60, endMinute: 60 },
      { weekday: 1, startMinute: -1, endMinute: 60 },
      { weekday: 1, startMinute: 0, endMinute: 1441 },
    ]) {
      expect(codeOf(() => assertValidWorkingHours([bad]))).toBe('invalid-working-hours');
    }
  });
});
