import { z } from 'zod';
import { APPOINTMENT_STATUSES, ROLES } from '../domain/types.js';

export const idParam = z.object({ id: z.uuid() });

export const isoDateTime = z.iso.datetime({ offset: true });
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Expected HH:mm');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const pageMeta = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

export const paged = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), meta: pageMeta });

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 7807 problem details' });

export const problems = (...statuses: (400 | 401 | 403 | 404 | 409 | 422)[]) =>
  Object.fromEntries(statuses.map((status) => [status, problemSchema]));

export const userSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: z.enum(ROLES),
    staffId: z.uuid().nullable(),
    customerId: z.uuid().nullable(),
  })
  .meta({ id: 'User' });

export const tokenPairSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().describe('Access token lifetime in seconds'),
  })
  .meta({ id: 'TokenPair' });

export const organizationSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    timezone: z.string().describe('IANA time zone, e.g. Europe/Madrid'),
    minNoticeMinutes: z.number().int(),
    maxAdvanceDays: z.number().int(),
    slotGranularityMinutes: z.number().int(),
    cancellationWindowHours: z.number().int(),
    autoConfirm: z.boolean(),
  })
  .meta({ id: 'Organization' });

export const serviceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    durationMinutes: z.number().int(),
    bufferMinutes: z.number().int(),
    priceCents: z.number().int(),
    currency: z.string(),
    active: z.boolean(),
  })
  .meta({ id: 'Service' });

export const staffSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    active: z.boolean(),
    serviceIds: z.array(z.uuid()),
  })
  .meta({ id: 'StaffMember' });

export const workingHoursSchema = z
  .object({
    weekday: z.number().int().min(1).max(7).describe('ISO weekday, 1 = Monday'),
    start: clockTime,
    end: clockTime,
  })
  .meta({ id: 'WorkingInterval' });

export const timeOffSchema = z
  .object({
    id: z.uuid(),
    staffId: z.uuid().nullable().describe('Null for an organization-wide closure'),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    reason: z.string().nullable(),
  })
  .meta({ id: 'TimeOff' });

export const customerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string().nullable(),
  })
  .meta({ id: 'Customer' });

export const appointmentSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(APPOINTMENT_STATUSES),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    service: z.object({ id: z.uuid(), name: z.string() }),
    staff: z.object({ id: z.uuid(), displayName: z.string() }),
    customer: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
    priceCents: z.number().int(),
    currency: z.string(),
    notes: z.string().nullable(),
    cancelledAt: isoDateTime.nullable(),
    cancellationReason: z.string().nullable(),
    createdAt: isoDateTime,
  })
  .meta({ id: 'Appointment' });

export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
