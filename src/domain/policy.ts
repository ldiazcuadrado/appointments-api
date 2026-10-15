import { forbidden } from './errors.js';
import type { Actor } from './types.js';

export const isAdmin = (actor: Actor): boolean => actor.role === 'admin';
export const isStaffSide = (actor: Actor): boolean => actor.role !== 'customer';

export function requireRole(actor: Actor, ...roles: Actor['role'][]): void {
  if (!roles.includes(actor.role)) throw forbidden();
}

export interface AppointmentOwnership {
  staffId: string;
  customerId: string;
}

/** Admins see everything, staff their own column, customers their own bookings. */
export function canAccessAppointment(actor: Actor, appointment: AppointmentOwnership): boolean {
  switch (actor.role) {
    case 'admin':
      return true;
    case 'staff':
      return actor.staffId === appointment.staffId;
    case 'customer':
      return actor.customerId === appointment.customerId;
  }
}

export function assertCanAccessAppointment(actor: Actor, appointment: AppointmentOwnership): void {
  if (!canAccessAppointment(actor, appointment)) throw forbidden();
}

/** Admins manage any staff member's schedule; staff only their own. */
export function assertCanManageStaff(actor: Actor, staffId: string | null): void {
  if (isAdmin(actor)) return;
  if (actor.role === 'staff' && staffId !== null && actor.staffId === staffId) return;
  throw forbidden();
}

export function assertCanAccessCustomer(actor: Actor, customerId: string): void {
  if (isStaffSide(actor)) return;
  if (actor.customerId !== customerId) throw forbidden();
}
