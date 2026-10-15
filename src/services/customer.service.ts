import { conflict, notFound } from '../domain/errors.js';
import { assertCanAccessCustomer } from '../domain/policy.js';
import type { Actor } from '../domain/types.js';
import type { Customer } from '../generated/prisma/client.js';
import type { Page, PageParams } from '../repositories/pagination.js';
import type { ServiceDeps } from './context.js';

export interface CustomerInput {
  name: string;
  email: string;
  phone?: string | null | undefined;
}

export class CustomerService {
  constructor(private readonly deps: ServiceDeps) {}

  list(params: PageParams, q?: string): Promise<Page<Customer>> {
    return this.deps.db.repos.customers.list(params, q ? { q } : {});
  }

  async get(actor: Actor, id: string): Promise<Customer> {
    assertCanAccessCustomer(actor, id);
    const customer = await this.deps.db.repos.customers.findById(id);
    if (!customer) throw notFound('Customer');
    return customer;
  }

  async create(input: CustomerInput): Promise<Customer> {
    const email = input.email.toLowerCase();
    if (await this.deps.db.repos.customers.findByEmail(email)) {
      throw conflict('email-taken', 'A customer with this email already exists');
    }
    return this.deps.db.repos.customers.create({
      name: input.name,
      email,
      phone: input.phone ?? null,
    });
  }

  async update(actor: Actor, id: string, patch: Partial<CustomerInput>): Promise<Customer> {
    await this.get(actor, id);
    const email = patch.email?.toLowerCase();
    if (email) {
      const other = await this.deps.db.repos.customers.findByEmail(email);
      if (other && other.id !== id) {
        throw conflict('email-taken', 'A customer with this email already exists');
      }
    }
    return this.deps.db.repos.customers.update(id, { ...patch, ...(email ? { email } : {}) });
  }
}
