import type { Prisma } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';
import type { AppointmentStatus, Interval } from '../domain/types.js';
import { toSkipTake, type Page, type PageParams } from './pagination.js';

const withRelations = {
  service: true,
  staff: true,
  customer: true,
} satisfies Prisma.AppointmentInclude;

export type AppointmentWithRelations = Prisma.AppointmentGetPayload<{
  include: typeof withRelations;
}>;

export interface AppointmentFilter {
  staffId?: string;
  customerId?: string;
  serviceId?: string;
  status?: AppointmentStatus;
  from?: Date;
  to?: Date;
}

const ACTIVE: AppointmentStatus[] = ['pending', 'confirmed'];

/** SQLSTATE 23P01: exclusion_violation, raised by the appointments_no_overlap constraint. */
export function isOverlapViolation(error: unknown): boolean {
  const text = (value: unknown): string => {
    if (value instanceof Error) return `${value.message} ${text(value.cause)}`;
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return typeof value === 'string' ? value : '';
  };
  const description = text(error);
  return description.includes('23P01') || description.includes('appointments_no_overlap');
}

export class AppointmentRepository {
  constructor(private readonly db: DbClient) {}

  async list(
    params: PageParams,
    filter: AppointmentFilter,
  ): Promise<Page<AppointmentWithRelations>> {
    const where: Prisma.AppointmentWhereInput = {
      ...(filter.staffId ? { staffId: filter.staffId } : {}),
      ...(filter.customerId ? { customerId: filter.customerId } : {}),
      ...(filter.serviceId ? { serviceId: filter.serviceId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.from || filter.to
        ? {
            startsAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.appointment.findMany({
        relationLoadStrategy: 'join',
        where,
        include: withRelations,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        ...toSkipTake(params),
      }),
      this.db.appointment.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string): Promise<AppointmentWithRelations | null> {
    return this.db.appointment.findUnique({
      relationLoadStrategy: 'join',
      where: { id },
      include: withRelations,
    });
  }

  create(data: Prisma.AppointmentUncheckedCreateInput): Promise<AppointmentWithRelations> {
    return this.db.appointment.create({
      relationLoadStrategy: 'join',
      data,
      include: withRelations,
    });
  }

  update(
    id: string,
    data: Prisma.AppointmentUncheckedUpdateInput,
  ): Promise<AppointmentWithRelations> {
    return this.db.appointment.update({
      relationLoadStrategy: 'join',
      where: { id },
      data,
      include: withRelations,
    });
  }

  /** Active appointments whose blocked range intersects the window, optionally ignoring one. */
  findActiveInRange(
    staffIds: string[],
    range: Interval,
    excludeId?: string,
  ): Promise<{ staffId: string; startsAt: Date; blockedUntil: Date }[]> {
    return this.db.appointment.findMany({
      where: {
        staffId: { in: staffIds },
        status: { in: ACTIVE },
        startsAt: { lt: range.end },
        blockedUntil: { gt: range.start },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { staffId: true, startsAt: true, blockedUntil: true },
    });
  }

  /** Confirmed or pending appointments starting inside the window that have no reminder yet. */
  findDueForReminder(range: Interval): Promise<AppointmentWithRelations[]> {
    return this.db.appointment.findMany({
      where: {
        status: { in: ACTIVE },
        reminderSentAt: null,
        startsAt: { gt: range.start, lte: range.end },
      },
      include: withRelations,
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
  }

  async markReminderSent(id: string, at: Date): Promise<void> {
    await this.db.appointment.update({ where: { id }, data: { reminderSentAt: at } });
  }
}
