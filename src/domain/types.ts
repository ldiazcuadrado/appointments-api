export const ROLES = ['admin', 'staff', 'customer'] as const;
export type Role = (typeof ROLES)[number];

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Half-open interval [start, end). */
export interface Interval {
  start: Date;
  end: Date;
}

/** A working interval on an ISO weekday (1 = Monday ... 7 = Sunday), in minutes since local midnight. */
export interface WorkingInterval {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ServiceTiming {
  durationMinutes: number;
  bufferMinutes: number;
}

export interface BookingRules {
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
}

export interface Actor {
  userId: string;
  role: Role;
  staffId: string | null;
  customerId: string | null;
}
