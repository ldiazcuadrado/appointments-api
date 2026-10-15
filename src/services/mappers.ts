import type { Actor } from '../domain/types.js';
import type { UserWithProfiles } from '../repositories/user.repository.js';

export function toActor(user: UserWithProfiles): Actor {
  return {
    userId: user.id,
    role: user.role,
    staffId: user.staffMember?.id ?? null,
    customerId: user.customer?.id ?? null,
  };
}
