import { assertValidWorkingHours } from '../domain/booking-rules.js';
import { conflict, invalid, notFound } from '../domain/errors.js';
import { assertCanManageStaff } from '../domain/policy.js';
import type { Actor, WorkingInterval } from '../domain/types.js';
import type { TimeOff, WorkingHours } from '../generated/prisma/client.js';
import { hashPassword } from '../lib/passwords.js';
import type { Page, PageParams } from '../repositories/pagination.js';
import type { StaffWithServices } from '../repositories/staff.repository.js';
import type { ServiceDeps } from './context.js';

export interface CreateStaffInput {
  displayName: string;
  email: string;
  password: string;
}

export class StaffService {
  constructor(private readonly deps: ServiceDeps) {}

  list(
    params: PageParams,
    filter: { includeInactive: boolean; serviceId?: string | undefined },
  ): Promise<Page<StaffWithServices>> {
    return this.deps.db.repos.staff.list(params, filter);
  }

  async get(id: string): Promise<StaffWithServices> {
    const staff = await this.deps.db.repos.staff.findById(id);
    if (!staff) throw notFound('Staff member');
    return staff;
  }

  async create(input: CreateStaffInput): Promise<StaffWithServices> {
    const email = input.email.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    return this.deps.db.transaction(async (repos) => {
      if (await repos.users.findByEmail(email)) {
        throw conflict('email-taken', 'An account with this email already exists');
      }
      const user = await repos.users.create({ email, passwordHash, role: 'staff' });
      return repos.staff.create({ displayName: input.displayName, userId: user.id });
    });
  }

  async update(id: string, patch: { displayName?: string; active?: boolean }) {
    await this.get(id);
    return this.deps.db.repos.staff.update(id, patch);
  }

  async setServices(id: string, serviceIds: string[]): Promise<StaffWithServices> {
    await this.get(id);
    const unique = [...new Set(serviceIds)];
    return this.deps.db.transaction(async (repos) => {
      for (const serviceId of unique) {
        if (!(await repos.services.findById(serviceId))) {
          throw invalid('unknown-service', `Service ${serviceId} does not exist`);
        }
      }
      await repos.staff.replaceServices(id, unique);
      const updated = await repos.staff.findById(id);
      if (!updated) throw notFound('Staff member');
      return updated;
    });
  }

  async getWorkingHours(id: string): Promise<WorkingHours[]> {
    await this.get(id);
    return this.deps.db.repos.staff.getWorkingHours([id]);
  }

  async setWorkingHours(
    actor: Actor,
    id: string,
    intervals: WorkingInterval[],
  ): Promise<WorkingHours[]> {
    assertCanManageStaff(actor, id);
    await this.get(id);
    assertValidWorkingHours(intervals);
    return this.deps.db.transaction(async (repos) => {
      await repos.staff.replaceWorkingHours(id, intervals);
      return repos.staff.getWorkingHours([id]);
    });
  }

  listTimeOff(filter: {
    staffId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
  }) {
    return this.deps.db.repos.staff.listTimeOff(filter);
  }

  async createTimeOff(
    actor: Actor,
    input: { staffId: string | null; startsAt: Date; endsAt: Date; reason?: string | undefined },
  ): Promise<TimeOff> {
    assertCanManageStaff(actor, input.staffId);
    if (input.startsAt >= input.endsAt) {
      throw invalid('invalid-range', 'endsAt must be after startsAt');
    }
    if (input.staffId) await this.get(input.staffId);
    return this.deps.db.repos.staff.createTimeOff({ ...input, reason: input.reason ?? null });
  }

  async deleteTimeOff(actor: Actor, id: string): Promise<void> {
    const timeOff = await this.deps.db.repos.staff.findTimeOff(id);
    if (!timeOff) throw notFound('Time off entry');
    assertCanManageStaff(actor, timeOff.staffId);
    await this.deps.db.repos.staff.deleteTimeOff(id);
  }
}
