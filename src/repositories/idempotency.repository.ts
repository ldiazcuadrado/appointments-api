import type { IdempotencyKey, Prisma } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';

export class IdempotencyRepository {
  constructor(private readonly db: DbClient) {}

  find(userId: string, key: string): Promise<IdempotencyKey | null> {
    return this.db.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  }

  create(data: Prisma.IdempotencyKeyUncheckedCreateInput): Promise<IdempotencyKey> {
    return this.db.idempotencyKey.create({ data });
  }
}
