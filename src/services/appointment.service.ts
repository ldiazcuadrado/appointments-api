import { createHash } from 'node:crypto';
import { localDateOf, slotsStartingAt } from '../domain/availability.js';
import {
  assertCancellable,
  assertReschedulable,
  assertTransition,
  blockedUntil,
  endsAt,
} from '../domain/booking-rules.js';
import {
  conflict,
  DomainError,
  forbidden,
  invalid,
  notFound,
  unprocessable,
} from '../domain/errors.js';
import { buildIcs } from '../domain/ics.js';
import { assertCanAccessAppointment, requireRole } from '../domain/policy.js';
import type { Actor, AppointmentStatus } from '../domain/types.js';
import type { Organization } from '../generated/prisma/client.js';
import type { Repositories } from '../repositories/index.js';
import type {
  AppointmentFilter,
  AppointmentWithRelations,
} from '../repositories/appointment.repository.js';
import { isOverlapViolation } from '../repositories/appointment.repository.js';
import type { Page, PageParams } from '../repositories/pagination.js';
import { dayWindow, loadSchedules } from './availability.service.js';
import type { ServiceDeps } from './context.js';

export interface CreateAppointmentInput {
  serviceId: string;
  staffId?: string | undefined;
  customerId?: string | undefined;
  startsAt: Date;
  notes?: string | undefined;
}

export interface CreateResult {
  appointment: AppointmentWithRelations;
  replayed: boolean;
}

const MAX_ASSIGNMENT_ATTEMPTS = 5;

const slotTaken = () => conflict('slot-unavailable', 'The requested time is no longer available');

export class AppointmentService {
  constructor(private readonly deps: ServiceDeps) {}

  async create(
    actor: Actor,
    input: CreateAppointmentInput,
    idempotencyKey?: string,
  ): Promise<CreateResult> {
    const customerId = this.resolveCustomerId(actor, input.customerId);
    const requestHash = hashRequest(actor, customerId, input);

    if (idempotencyKey) {
      const replay = await this.findReplay(actor, idempotencyKey, requestHash);
      if (replay) return { appointment: replay, replayed: true };
    }

    try {
      const appointment = await this.withAssignmentRetry(input, () =>
        this.deps.db.transaction(async (repos) => {
          const created = await this.book(repos, actor, customerId, input);
          if (idempotencyKey) {
            await repos.idempotency.create({
              userId: actor.userId,
              key: idempotencyKey,
              requestHash,
              appointmentId: created.id,
            });
          }
          return created;
        }),
      );
      return { appointment, replayed: false };
    } catch (error) {
      // A concurrent request with the same key may have won the race; if so, replay its result.
      if (idempotencyKey && isRaceLoss(error)) {
        const replay = await this.findReplay(actor, idempotencyKey, requestHash);
        if (replay) return { appointment: replay, replayed: true };
      }
      throw error;
    }
  }

  async get(actor: Actor, id: string): Promise<AppointmentWithRelations> {
    const appointment = await this.deps.db.repos.appointments.findById(id);
    if (!appointment) throw notFound('Appointment');
    assertCanAccessAppointment(actor, appointment);
    return appointment;
  }

  list(
    actor: Actor,
    params: PageParams,
    filter: AppointmentFilter,
  ): Promise<Page<AppointmentWithRelations>> {
    const scoped: AppointmentFilter = { ...filter };
    if (actor.role === 'customer') scoped.customerId = actor.customerId ?? 'none';
    if (actor.role === 'staff') scoped.staffId = actor.staffId ?? 'none';
    return this.deps.db.repos.appointments.list(params, scoped);
  }

  async cancel(actor: Actor, id: string, reason?: string): Promise<AppointmentWithRelations> {
    const appointment = await this.get(actor, id);
    const organization = await this.organization();
    const now = this.deps.clock.now();
    assertCancellable({
      actorRole: actor.role,
      status: appointment.status,
      startsAt: appointment.startsAt,
      now,
      cancellationWindowHours: organization.cancellationWindowHours,
    });
    return this.deps.db.repos.appointments.update(id, {
      status: 'cancelled',
      cancelledAt: now,
      cancellationReason: reason ?? null,
    });
  }

  async reschedule(
    actor: Actor,
    id: string,
    input: { startsAt: Date; staffId?: string | undefined },
  ): Promise<AppointmentWithRelations> {
    const current = await this.get(actor, id);
    const organization = await this.organization();
    assertReschedulable({
      actorRole: actor.role,
      status: current.status,
      startsAt: current.startsAt,
      now: this.deps.clock.now(),
      cancellationWindowHours: organization.cancellationWindowHours,
    });
    if (input.staffId && input.staffId !== current.staffId && actor.role === 'customer') {
      throw forbidden('Customers cannot change the staff member of an appointment');
    }

    try {
      return await this.deps.db.transaction(async (repos) => {
        const staff = await repos.staff.findForService(
          current.serviceId,
          input.staffId ?? current.staffId,
        );
        if (staff.length === 0) {
          throw unprocessable(
            'staff-unavailable-for-service',
            'The staff member is inactive or does not perform this service',
          );
        }
        const day = localDateOf(input.startsAt, organization.timezone);
        const window = dayWindow(day, day, organization.timezone);
        const schedules = await loadSchedules(repos, staff, window, current.id);
        const [slot] = slotsStartingAt(
          {
            timezone: organization.timezone,
            service: current.service,
            rules: organization,
            staff: schedules,
            now: this.deps.clock.now(),
          },
          input.startsAt,
        );
        if (!slot) throw slotTaken();
        return repos.appointments.update(id, {
          staffId: slot.staffId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          blockedUntil: blockedUntil(slot.startsAt, current.service),
          reminderSentAt: null,
        });
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw slotTaken();
      throw error;
    }
  }

  async setStatus(
    actor: Actor,
    id: string,
    status: Extract<AppointmentStatus, 'confirmed' | 'completed' | 'no_show'>,
  ): Promise<AppointmentWithRelations> {
    requireRole(actor, 'admin', 'staff');
    const appointment = await this.get(actor, id);
    assertTransition(appointment.status, status, appointment.startsAt, this.deps.clock.now());
    return this.deps.db.repos.appointments.update(id, { status });
  }

  async calendarEntry(actor: Actor, id: string): Promise<{ filename: string; content: string }> {
    const appointment = await this.get(actor, id);
    const organization = await this.organization();
    const status =
      appointment.status === 'cancelled'
        ? 'CANCELLED'
        : appointment.status === 'pending'
          ? 'TENTATIVE'
          : 'CONFIRMED';
    const content = buildIcs({
      uid: `${appointment.id}@appointments-api`,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      summary: `${appointment.service.name} at ${organization.name}`,
      description: `With ${appointment.staff.displayName}`,
      status,
      sequence: Math.floor(
        (appointment.updatedAt.getTime() - appointment.createdAt.getTime()) / 1000,
      ),
      stamp: appointment.updatedAt,
    });
    return { filename: `appointment-${appointment.id}.ics`, content };
  }

  /**
   * When the API picks the staff member, losing a race for one of them is not a
   * conflict as long as another is free: re-read availability and try again.
   * Each lost race means some other request took a slot, so the loop is bounded.
   */
  private async withAssignmentRetry<T>(
    input: CreateAppointmentInput,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const attempts = input.staffId ? 1 : MAX_ASSIGNMENT_ATTEMPTS;
    for (let n = 1; ; n += 1) {
      try {
        return await attempt();
      } catch (error) {
        const lostRace = error instanceof DomainError && error.code === 'slot-unavailable';
        if (!lostRace || n >= attempts) throw error;
      }
    }
  }

  private resolveCustomerId(actor: Actor, requested: string | undefined): string {
    if (actor.role === 'customer') {
      if (!actor.customerId) throw forbidden('Your account has no customer profile');
      if (requested && requested !== actor.customerId) {
        throw forbidden('Customers can only book for themselves');
      }
      return actor.customerId;
    }
    if (!requested)
      throw invalid('customer-required', 'customerId is required when booking for a customer');
    return requested;
  }

  private async findReplay(actor: Actor, key: string, requestHash: string) {
    const existing = await this.deps.db.repos.idempotency.find(actor.userId, key);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw unprocessable(
        'idempotency-key-reuse',
        'This Idempotency-Key was already used with a different request',
      );
    }
    return this.deps.db.repos.appointments.findById(existing.appointmentId);
  }

  private async organization(): Promise<Organization> {
    const organization = await this.deps.db.repos.organizations.get();
    if (!organization) throw notFound('Organization');
    return organization;
  }

  private async book(
    repos: Repositories,
    actor: Actor,
    customerId: string,
    input: CreateAppointmentInput,
  ): Promise<AppointmentWithRelations> {
    const organization = await repos.organizations.get();
    if (!organization) throw notFound('Organization');
    const service = await repos.services.findById(input.serviceId);
    if (!service?.active) throw notFound('Service');
    if (!(await repos.customers.findById(customerId))) throw notFound('Customer');

    const staff = await repos.staff.findForService(service.id, input.staffId);
    if (input.staffId && staff.length === 0) {
      throw unprocessable(
        'staff-unavailable-for-service',
        'The staff member is inactive or does not perform this service',
      );
    }

    const day = localDateOf(input.startsAt, organization.timezone);
    const schedules = await loadSchedules(repos, staff, dayWindow(day, day, organization.timezone));
    const candidates = slotsStartingAt(
      {
        timezone: organization.timezone,
        service,
        rules: organization,
        staff: schedules,
        now: this.deps.clock.now(),
      },
      input.startsAt,
    );
    const load = (staffId: string) =>
      schedules.find((s) => s.staffId === staffId)?.booked.length ?? 0;
    const [slot] = [...candidates].sort(
      (a, b) => load(a.staffId) - load(b.staffId) || a.staffId.localeCompare(b.staffId),
    );
    if (!slot) throw slotTaken();

    try {
      return await repos.appointments.create({
        serviceId: service.id,
        staffId: slot.staffId,
        customerId,
        status: actor.role === 'customer' && !organization.autoConfirm ? 'pending' : 'confirmed',
        startsAt: slot.startsAt,
        endsAt: endsAt(slot.startsAt, service),
        blockedUntil: blockedUntil(slot.startsAt, service),
        priceCents: service.priceCents,
        currency: service.currency,
        notes: input.notes ?? null,
      });
    } catch (error) {
      if (isOverlapViolation(error)) throw slotTaken();
      throw error;
    }
  }
}

function hashRequest(actor: Actor, customerId: string, input: CreateAppointmentInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        actor.userId,
        customerId,
        input.serviceId,
        input.staffId ?? null,
        input.startsAt.toISOString(),
        input.notes ?? null,
      ]),
    )
    .digest('hex');
}

function isRaceLoss(error: unknown): boolean {
  if (error instanceof DomainError) return error.code === 'slot-unavailable';
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
