import { invalid, notFound } from '../domain/errors.js';
import { isValidTimezone } from '../domain/availability.js';
import type { Organization } from '../generated/prisma/client.js';
import type { ServiceDeps } from './context.js';

export interface OrganizationPatch {
  name?: string;
  timezone?: string;
  minNoticeMinutes?: number;
  maxAdvanceDays?: number;
  slotGranularityMinutes?: number;
  cancellationWindowHours?: number;
  autoConfirm?: boolean;
}

export class OrganizationService {
  constructor(private readonly deps: ServiceDeps) {}

  async get(): Promise<Organization> {
    const organization = await this.deps.db.repos.organizations.get();
    if (!organization) throw notFound('Organization');
    return organization;
  }

  async update(patch: OrganizationPatch): Promise<Organization> {
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      throw invalid('invalid-timezone', `Unknown time zone "${patch.timezone}"`);
    }
    const current = await this.get();
    return this.deps.db.repos.organizations.update(current.id, patch);
  }
}
