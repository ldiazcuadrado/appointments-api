import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Role } from '../domain/types.js';

export interface AccessClaims {
  sub: string;
  role: Role;
}

export interface TokenSigner {
  signAccess(claims: AccessClaims): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
}

const ISSUER = 'appointments-api';

export function createTokenSigner(secret: string, ttlSeconds: number): TokenSigner {
  const key = new TextEncoder().encode(secret);
  return {
    signAccess: ({ sub, role }) =>
      new SignJWT({ role })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key),
    async verifyAccess(token) {
      const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] });
      const role = payload.role;
      if (!payload.sub || (role !== 'admin' && role !== 'staff' && role !== 'customer')) {
        throw new Error('Malformed access token');
      }
      return { sub: payload.sub, role };
    },
  };
}

export const generateRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
