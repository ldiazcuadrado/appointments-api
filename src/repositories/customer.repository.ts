import type { Customer, Prisma } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';
import { toSkipTake, type Page, type PageParams } from './pagination.js';

export class CustomerRepository {
  constructor(private readonly db: DbClient) {}

  async list(params: PageParams, filter: { q?: string }): Promise<Page<Customer>> {
    const where: Prisma.CustomerWhereInput = filter.q
      ? {
          OR: [
            { name: { contains: filter.q, mode: 'insensitive' } },
            { email: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {};
    const [items, total] = await Promise.all([
      this.db.customer.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...toSkipTake(params),
      }),
      this.db.customer.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string): Promise<Customer | null> {
    return this.db.customer.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<Customer | null> {
    return this.db.customer.findUnique({ where: { email } });
  }

  create(data: Prisma.CustomerUncheckedCreateInput): Promise<Customer> {
    return this.db.customer.create({ data });
  }

  update(id: string, data: Prisma.CustomerUpdateInput): Promise<Customer> {
    return this.db.customer.update({ where: { id }, data });
  }
}
