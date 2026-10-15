import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { Prisma } from '../generated/prisma/client.js';
export { PrismaClient };

export function createPrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type DbClient = Pick<
  PrismaClient,
  | 'organization'
  | 'user'
  | 'refreshToken'
  | 'service'
  | 'staffMember'
  | 'staffService'
  | 'workingHours'
  | 'timeOff'
  | 'customer'
  | 'appointment'
  | 'idempotencyKey'
>;
