import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { buildIcs, escapeText, foldLine } from '../../src/domain/ics.js';
import {
  assertCanAccessAppointment,
  assertCanAccessCustomer,
  assertCanManageStaff,
  canAccessAppointment,
  requireRole,
} from '../../src/domain/policy.js';
import type { Actor } from '../../src/domain/types.js';

const admin: Actor = { userId: 'u1', role: 'admin', staffId: null, customerId: null };
const staff: Actor = { userId: 'u2', role: 'staff', staffId: 's1', customerId: null };
const customer: Actor = { userId: 'u3', role: 'customer', staffId: null, customerId: 'c1' };

const forbids = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError && error.kind === 'forbidden';
  }
  return false;
};

describe('policy', () => {
  it('scopes appointment access by role', () => {
    const own = { staffId: 's1', customerId: 'c1' };
    const other = { staffId: 's2', customerId: 'c2' };
    expect(canAccessAppointment(admin, other)).toBe(true);
    expect(canAccessAppointment(staff, own)).toBe(true);
    expect(canAccessAppointment(staff, other)).toBe(false);
    expect(canAccessAppointment(customer, own)).toBe(true);
    expect(canAccessAppointment(customer, other)).toBe(false);
    expect(forbids(() => assertCanAccessAppointment(customer, other))).toBe(true);
    expect(forbids(() => assertCanAccessAppointment(staff, own))).toBe(false);
  });

  it('restricts staff schedule management to admins and the member themself', () => {
    expect(forbids(() => assertCanManageStaff(admin, 's2'))).toBe(false);
    expect(forbids(() => assertCanManageStaff(admin, null))).toBe(false);
    expect(forbids(() => assertCanManageStaff(staff, 's1'))).toBe(false);
    expect(forbids(() => assertCanManageStaff(staff, 's2'))).toBe(true);
    expect(forbids(() => assertCanManageStaff(staff, null))).toBe(true);
    expect(forbids(() => assertCanManageStaff(customer, 's1'))).toBe(true);
  });

  it('lets customers read only their own customer record', () => {
    expect(forbids(() => assertCanAccessCustomer(staff, 'c9'))).toBe(false);
    expect(forbids(() => assertCanAccessCustomer(customer, 'c1'))).toBe(false);
    expect(forbids(() => assertCanAccessCustomer(customer, 'c9'))).toBe(true);
  });

  it('requires one of the listed roles', () => {
    expect(forbids(() => requireRole(admin, 'admin'))).toBe(false);
    expect(forbids(() => requireRole(staff, 'admin'))).toBe(true);
    expect(forbids(() => requireRole(staff, 'admin', 'staff'))).toBe(false);
  });
});

describe('ics', () => {
  const base = {
    uid: 'abc@appointments-api',
    startsAt: new Date('2025-06-10T12:00:00Z'),
    endsAt: new Date('2025-06-10T12:45:30.500Z'),
    summary: 'Haircut',
    status: 'CONFIRMED' as const,
    stamp: new Date('2025-06-01T08:00:00Z'),
  };

  it('renders a CRLF-terminated VEVENT in UTC', () => {
    const ics = buildIcs({ ...base, description: 'Bring ID', location: 'Main St' });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20250610T120000Z\r\n');
    expect(ics).toContain('DTEND:20250610T124530Z\r\n');
    expect(ics).toContain('DTSTAMP:20250601T080000Z\r\n');
    expect(ics).toContain('DESCRIPTION:Bring ID\r\n');
    expect(ics).toContain('LOCATION:Main St\r\n');
    expect(ics).toContain('SEQUENCE:0\r\n');
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('omits optional properties and carries status and sequence', () => {
    const ics = buildIcs({ ...base, status: 'CANCELLED', sequence: 3 });
    expect(ics).not.toContain('DESCRIPTION');
    expect(ics).not.toContain('LOCATION');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:3');
  });

  it('escapes text values', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe(String.raw`a\,b\;c\\d\ne`);
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const line = `SUMMARY:${'é'.repeat(80)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(foldLine('short')).toBe('short');
  });
});
