import type { Prisma, RefreshToken } from '../generated/prisma/client.js';
import type { DbClient } from '../lib/prisma.js';

const withProfiles = { staffMember: true, customer: true } satisfies Prisma.UserInclude;

export type UserWithProfiles = Prisma.UserGetPayload<{ include: typeof withProfiles }>;

export class UserRepository {
  constructor(private readonly db: DbClient) {}

  findByEmail(email: string): Promise<UserWithProfiles | null> {
    return this.db.user.findUnique({
      relationLoadStrategy: 'join',
      where: { email },
      include: withProfiles,
    });
  }

  findById(id: string): Promise<UserWithProfiles | null> {
    return this.db.user.findUnique({
      relationLoadStrategy: 'join',
      where: { id },
      include: withProfiles,
    });
  }

  create(data: Prisma.UserCreateInput): Promise<UserWithProfiles> {
    return this.db.user.create({ relationLoadStrategy: 'join', data, include: withProfiles });
  }
}

export class RefreshTokenRepository {
  constructor(private readonly db: DbClient) {}

  create(data: Prisma.RefreshTokenUncheckedCreateInput): Promise<RefreshToken> {
    return this.db.refreshToken.create({ data });
  }

  findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.db.refreshToken.findUnique({ where: { tokenHash } });
  }

  /** Revokes a single token; returns false when another request already did. */
  async revokeIfActive(id: string, now: Date): Promise<boolean> {
    const result = await this.db.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
