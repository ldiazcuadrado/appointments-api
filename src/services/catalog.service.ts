import { notFound } from '../domain/errors.js';
import type { Service } from '../generated/prisma/client.js';
import type { Page, PageParams } from '../repositories/pagination.js';
import type { ServiceDeps } from './context.js';

export interface ServiceInput {
  name: string;
  description?: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
}

export class CatalogService {
  constructor(private readonly deps: ServiceDeps) {}

  list(params: PageParams, includeInactive: boolean): Promise<Page<Service>> {
    return this.deps.db.repos.services.list(params, { includeInactive });
  }

  async get(id: string): Promise<Service> {
    const service = await this.deps.db.repos.services.findById(id);
    if (!service) throw notFound('Service');
    return service;
  }

  create(
    input: Partial<ServiceInput> & Pick<ServiceInput, 'name' | 'durationMinutes' | 'priceCents'>,
  ) {
    return this.deps.db.repos.services.create({
      ...input,
      description: input.description ?? null,
      currency: input.currency?.toUpperCase() ?? 'USD',
    });
  }

  async update(id: string, patch: Partial<ServiceInput>): Promise<Service> {
    await this.get(id);
    return this.deps.db.repos.services.update(id, {
      ...patch,
      ...(patch.currency ? { currency: patch.currency.toUpperCase() } : {}),
    });
  }
}
