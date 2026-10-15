import type { Prisma, Service } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';
import { toSkipTake, type Page, type PageParams } from './pagination.js';

export class ServiceRepository {
  constructor(private readonly db: DbClient) {}

  async list(params: PageParams, filter: { includeInactive: boolean }): Promise<Page<Service>> {
    const where: Prisma.ServiceWhereInput = filter.includeInactive ? {} : { active: true };
    const [items, total] = await Promise.all([
      this.db.service.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...toSkipTake(params),
      }),
      this.db.service.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string): Promise<Service | null> {
    return this.db.service.findUnique({ where: { id } });
  }

  create(data: Prisma.ServiceCreateInput): Promise<Service> {
    return this.db.service.create({ data });
  }

  update(id: string, data: Prisma.ServiceUpdateInput): Promise<Service> {
    return this.db.service.update({ where: { id }, data });
  }
}
