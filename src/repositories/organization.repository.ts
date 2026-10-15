import type { Organization, Prisma } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';

export class OrganizationRepository {
  constructor(private readonly db: DbClient) {}

  get(): Promise<Organization | null> {
    return this.db.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  }

  create(data: Prisma.OrganizationCreateInput): Promise<Organization> {
    return this.db.organization.create({ data });
  }

  update(id: string, data: Prisma.OrganizationUpdateInput): Promise<Organization> {
    return this.db.organization.update({ where: { id }, data });
  }
}
