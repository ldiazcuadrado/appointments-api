import type { z } from 'zod';
import type {
  Customer,
  Organization,
  Service,
  TimeOff,
  WorkingHours,
} from '../generated/prisma/client.js';
import { minutesToClock } from '../domain/booking-rules.js';
import type { AppointmentWithRelations } from '../repositories/appointment.repository.js';
import type { StaffWithServices } from '../repositories/staff.repository.js';
import type { UserWithProfiles } from '../repositories/user.repository.js';
import type { Page, PageParams } from '../repositories/pagination.js';
import type {
  appointmentSchema,
  customerSchema,
  organizationSchema,
  serviceSchema,
  staffSchema,
  timeOffSchema,
  userSchema,
  workingHoursSchema,
} from './schemas.js';

type Out<T extends z.ZodType> = z.output<T>;

export const toUserDto = (user: UserWithProfiles): Out<typeof userSchema> => ({
  id: user.id,
  email: user.email,
  role: user.role,
  staffId: user.staffMember?.id ?? null,
  customerId: user.customer?.id ?? null,
});

export const toOrganizationDto = (o: Organization): Out<typeof organizationSchema> => ({
  id: o.id,
  name: o.name,
  timezone: o.timezone,
  minNoticeMinutes: o.minNoticeMinutes,
  maxAdvanceDays: o.maxAdvanceDays,
  slotGranularityMinutes: o.slotGranularityMinutes,
  cancellationWindowHours: o.cancellationWindowHours,
  autoConfirm: o.autoConfirm,
});

export const toServiceDto = (s: Service): Out<typeof serviceSchema> => ({
  id: s.id,
  name: s.name,
  description: s.description,
  durationMinutes: s.durationMinutes,
  bufferMinutes: s.bufferMinutes,
  priceCents: s.priceCents,
  currency: s.currency,
  active: s.active,
});

export const toStaffDto = (s: StaffWithServices): Out<typeof staffSchema> => ({
  id: s.id,
  displayName: s.displayName,
  active: s.active,
  serviceIds: s.services.map((x) => x.serviceId),
});

export const toWorkingHoursDto = (h: WorkingHours): Out<typeof workingHoursSchema> => ({
  weekday: h.weekday,
  start: minutesToClock(h.startMinute),
  end: minutesToClock(h.endMinute),
});

export const toTimeOffDto = (t: TimeOff): Out<typeof timeOffSchema> => ({
  id: t.id,
  staffId: t.staffId,
  startsAt: t.startsAt.toISOString(),
  endsAt: t.endsAt.toISOString(),
  reason: t.reason,
});

export const toCustomerDto = (c: Customer): Out<typeof customerSchema> => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
});

export const toAppointmentDto = (a: AppointmentWithRelations): Out<typeof appointmentSchema> => ({
  id: a.id,
  status: a.status,
  startsAt: a.startsAt.toISOString(),
  endsAt: a.endsAt.toISOString(),
  service: { id: a.service.id, name: a.service.name },
  staff: { id: a.staff.id, displayName: a.staff.displayName },
  customer: { id: a.customer.id, name: a.customer.name, email: a.customer.email },
  priceCents: a.priceCents,
  currency: a.currency,
  notes: a.notes,
  cancelledAt: a.cancelledAt?.toISOString() ?? null,
  cancellationReason: a.cancellationReason,
  createdAt: a.createdAt.toISOString(),
});

export function toPage<T, U>(page: Page<T>, params: PageParams, map: (item: T) => U) {
  return {
    data: page.items.map(map),
    meta: {
      page: params.page,
      pageSize: params.pageSize,
      total: page.total,
      totalPages: Math.ceil(page.total / params.pageSize),
    },
  };
}
