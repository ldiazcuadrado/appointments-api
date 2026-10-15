import type { Prisma, TimeOff, WorkingHours } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';
import type { Interval, WorkingInterval } from '../domain/types.js';
import { toSkipTake, type Page, type PageParams } from './pagination.js';

const withServices = {
  services: { select: { serviceId: true } },
} satisfies Prisma.StaffMemberInclude;

export type StaffWithServices = Prisma.StaffMemberGetPayload<{ include: typeof withServices }>;

export class StaffRepository {
  constructor(private readonly db: DbClient) {}

  async list(
    params: PageParams,
    filter: { includeInactive: boolean; serviceId?: string },
  ): Promise<Page<StaffWithServices>> {
    const where: Prisma.StaffMemberWhereInput = {
      ...(filter.includeInactive ? {} : { active: true }),
      ...(filter.serviceId ? { services: { some: { serviceId: filter.serviceId } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.staffMember.findMany({
        relationLoadStrategy: 'join',
        where,
        include: withServices,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        ...toSkipTake(params),
      }),
      this.db.staffMember.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string): Promise<StaffWithServices | null> {
    return this.db.staffMember.findUnique({
      relationLoadStrategy: 'join',
      where: { id },
      include: withServices,
    });
  }

  /** Active staff able to perform a service, ordered by id for stable results. */
  findForService(serviceId: string, staffId?: string): Promise<StaffWithServices[]> {
    return this.db.staffMember.findMany({
      where: {
        active: true,
        ...(staffId ? { id: staffId } : {}),
        services: { some: { serviceId } },
      },
      include: withServices,
      orderBy: { id: 'asc' },
    });
  }

  create(data: Prisma.StaffMemberUncheckedCreateInput): Promise<StaffWithServices> {
    return this.db.staffMember.create({
      relationLoadStrategy: 'join',
      data,
      include: withServices,
    });
  }

  update(id: string, data: Prisma.StaffMemberUpdateInput): Promise<StaffWithServices> {
    return this.db.staffMember.update({
      relationLoadStrategy: 'join',
      where: { id },
      data,
      include: withServices,
    });
  }

  async replaceServices(staffId: string, serviceIds: string[]): Promise<void> {
    await this.db.staffService.deleteMany({ where: { staffId } });
    await this.db.staffService.createMany({
      data: serviceIds.map((serviceId) => ({ staffId, serviceId })),
    });
  }

  getWorkingHours(staffIds: string[]): Promise<WorkingHours[]> {
    return this.db.workingHours.findMany({
      where: { staffId: { in: staffIds } },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
  }

  async replaceWorkingHours(staffId: string, intervals: readonly WorkingInterval[]): Promise<void> {
    await this.db.workingHours.deleteMany({ where: { staffId } });
    await this.db.workingHours.createMany({
      data: intervals.map((interval) => ({ staffId, ...interval })),
    });
  }

  listTimeOff(filter: { staffId?: string; from?: Date; to?: Date }): Promise<TimeOff[]> {
    return this.db.timeOff.findMany({
      where: {
        ...(filter.staffId ? { OR: [{ staffId: filter.staffId }, { staffId: null }] } : {}),
        ...(filter.from ? { endsAt: { gt: filter.from } } : {}),
        ...(filter.to ? { startsAt: { lt: filter.to } } : {}),
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  /** Time off that blocks any of the given staff, including organization-wide closures. */
  findBlockingTimeOff(staffIds: string[], range: Interval): Promise<TimeOff[]> {
    return this.db.timeOff.findMany({
      where: {
        OR: [{ staffId: { in: staffIds } }, { staffId: null }],
        startsAt: { lt: range.end },
        endsAt: { gt: range.start },
      },
    });
  }

  findTimeOff(id: string): Promise<TimeOff | null> {
    return this.db.timeOff.findUnique({ where: { id } });
  }

  createTimeOff(data: Prisma.TimeOffUncheckedCreateInput): Promise<TimeOff> {
    return this.db.timeOff.create({ data });
  }

  async deleteTimeOff(id: string): Promise<void> {
    await this.db.timeOff.delete({ where: { id } });
  }
}
