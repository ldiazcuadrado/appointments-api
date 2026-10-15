import { randomUUID } from 'node:crypto';
import { conflict, DomainError } from '../domain/errors.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { generateRefreshToken, hashToken, type TokenSigner } from '../lib/tokens.js';
import type { Customer } from '../generated/prisma/client.js';
import type { Repositories } from '../repositories/index.js';
import type { UserWithProfiles } from '../repositories/user.repository.js';
import type { ServiceDeps } from './context.js';
import { toActor } from './mappers.js';
import type { Actor } from '../domain/types.js';

export interface AuthConfig {
  refreshTtlDays: number;
  accessTtlSeconds: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  phone?: string | undefined;
}

const unauthorized = (message: string) => new DomainError('unauthorized', 'unauthorized', message);

export class AuthService {
  /** Verified against when the account does not exist, so response time does not reveal it. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly signer: TokenSigner,
    private readonly config: AuthConfig,
  ) {}

  async register(input: RegisterInput): Promise<{ tokens: TokenPair; user: UserWithProfiles }> {
    const email = input.email.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const user = await this.deps.db.transaction(async (repos) => {
      if (await repos.users.findByEmail(email)) {
        throw conflict('email-taken', 'An account with this email already exists');
      }
      const existing = await repos.customers.findByEmail(email);
      const created = await repos.users.create({
        email,
        passwordHash,
        role: 'customer',
        ...(existing
          ? {}
          : { customer: { create: { name: input.name, email, phone: input.phone ?? null } } }),
      });
      if (existing) await this.linkCustomer(repos, existing, created.id);
      const reloaded = await repos.users.findById(created.id);
      if (!reloaded) throw new Error('User vanished inside its own transaction');
      return reloaded;
    });
    return { user, tokens: await this.issue(this.deps.db.repos, user) };
  }

  async login(
    emailInput: string,
    password: string,
  ): Promise<{ tokens: TokenPair; user: UserWithProfiles }> {
    const user = await this.deps.db.repos.users.findByEmail(emailInput.toLowerCase());
    this.dummyHash ??= hashPassword(randomUUID());
    const valid = await verifyPassword(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !valid) throw unauthorized('Invalid email or password');
    return { user, tokens: await this.issue(this.deps.db.repos, user) };
  }

  /** Rotates a refresh token. Presenting a token that was already rotated revokes the whole family. */
  async refresh(token: string): Promise<TokenPair> {
    const now = this.deps.clock.now();
    const stored = await this.deps.db.repos.refreshTokens.findByHash(hashToken(token));
    if (!stored) throw unauthorized('Invalid refresh token');
    if (stored.revokedAt) {
      await this.deps.db.repos.refreshTokens.revokeFamily(stored.familyId, now);
      throw unauthorized('Refresh token has already been used');
    }
    if (stored.expiresAt <= now) throw unauthorized('Refresh token has expired');

    return this.deps.db.transaction(async (repos) => {
      if (!(await repos.refreshTokens.revokeIfActive(stored.id, now))) {
        throw unauthorized('Refresh token has already been used');
      }
      const user = await repos.users.findById(stored.userId);
      if (!user) throw unauthorized('Account no longer exists');
      return this.issue(repos, user, stored.familyId);
    });
  }

  async logout(token: string): Promise<void> {
    const stored = await this.deps.db.repos.refreshTokens.findByHash(hashToken(token));
    if (stored) {
      await this.deps.db.repos.refreshTokens.revokeFamily(stored.familyId, this.deps.clock.now());
    }
  }

  async actorFor(userId: string): Promise<{ actor: Actor; user: UserWithProfiles }> {
    const user = await this.deps.db.repos.users.findById(userId);
    if (!user) throw unauthorized('Account no longer exists');
    return { actor: toActor(user), user };
  }

  private async linkCustomer(repos: Repositories, customer: Customer, userId: string) {
    if (customer.userId) throw conflict('email-taken', 'An account with this email already exists');
    await repos.customers.update(customer.id, { user: { connect: { id: userId } } });
  }

  private async issue(
    repos: Repositories,
    user: UserWithProfiles,
    familyId?: string,
  ): Promise<TokenPair> {
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + this.config.refreshTtlDays * 86_400_000,
    );
    await repos.refreshTokens.create({
      userId: user.id,
      familyId: familyId ?? randomUUID(),
      tokenHash: hashToken(refreshToken),
      expiresAt,
    });
    return {
      accessToken: await this.signer.signAccess({ sub: user.id, role: user.role }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.accessTtlSeconds,
    };
  }
}
