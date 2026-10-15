import type { Clock } from '../lib/clock.js';
import type { TokenSigner } from '../lib/tokens.js';
import type { Database } from '../repositories/index.js';
import { AppointmentService } from './appointment.service.js';
import { AuthService, type AuthConfig } from './auth.service.js';
import { AvailabilityService } from './availability.service.js';
import { CatalogService } from './catalog.service.js';
import { CustomerService } from './customer.service.js';
import { OrganizationService } from './organization.service.js';
import { StaffService } from './staff.service.js';

export interface Services {
  auth: AuthService;
  organization: OrganizationService;
  catalog: CatalogService;
  staff: StaffService;
  customers: CustomerService;
  availability: AvailabilityService;
  appointments: AppointmentService;
}

export function createServices(
  db: Database,
  clock: Clock,
  signer: TokenSigner,
  authConfig: AuthConfig,
): Services {
  const deps = { db, clock };
  return {
    auth: new AuthService(deps, signer, authConfig),
    organization: new OrganizationService(deps),
    catalog: new CatalogService(deps),
    staff: new StaffService(deps),
    customers: new CustomerService(deps),
    availability: new AvailabilityService(deps),
    appointments: new AppointmentService(deps),
  };
}
