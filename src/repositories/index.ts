import type { DbClient, PrismaClient } from '../lib/prisma.js';
import { AppointmentRepository } from './appointment.repository.js';
import { CustomerRepository } from './customer.repository.js';
import { IdempotencyRepository } from './idempotency.repository.js';
import { OrganizationRepository } from './organization.repository.js';
import { ServiceRepository } from './service.repository.js';
import { StaffRepository } from './staff.repository.js';
import { RefreshTokenRepository, UserRepository } from './user.repository.js';

export interface Repositories {
  organizations: OrganizationRepository;
  users: UserRepository;
  refreshTokens: RefreshTokenRepository;
  services: ServiceRepository;
  staff: StaffRepository;
  customers: CustomerRepository;
  appointments: AppointmentRepository;
  idempotency: IdempotencyRepository;
}

export function createRepositories(db: DbClient): Repositories {
  return {
    organizations: new OrganizationRepository(db),
    users: new UserRepository(db),
    refreshTokens: new RefreshTokenRepository(db),
    services: new ServiceRepository(db),
    staff: new StaffRepository(db),
    customers: new CustomerRepository(db),
    appointments: new AppointmentRepository(db),
    idempotency: new IdempotencyRepository(db),
  };
}

/** Repositories bound to the pool, plus a way to run several of them in one transaction. */
export class Database {
  readonly repos: Repositories;

  constructor(private readonly prisma: PrismaClient) {
    this.repos = createRepositories(prisma);
  }

  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(createRepositories(tx)));
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  disconnect(): Promise<void> {
    return this.prisma.$disconnect();
  }
}
