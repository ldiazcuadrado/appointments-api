import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { DomainError } from '../../domain/errors.js';
import type { Actor } from '../../domain/types.js';
import type { TokenSigner } from '../../lib/tokens.js';
import type { AuthService } from '../../services/auth.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const unauthorized = (message: string) => new DomainError('unauthorized', 'unauthorized', message);

export interface AuthPluginOptions {
  signer: TokenSigner;
  auth: AuthService;
}

/** Verifies the bearer token, then loads the caller's current role and profiles from the database. */
export const authPlugin = fp<AuthPluginOptions>(
  (app, { signer, auth }) => {
    app.decorateRequest('actor');
    app.decorate('authenticate', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
      if (!token) throw unauthorized('Missing bearer token');
      let subject: string;
      try {
        subject = (await signer.verifyAccess(token)).sub;
      } catch {
        throw unauthorized('Invalid or expired access token');
      }
      request.actor = (await auth.actorFor(subject)).actor;
    });
    return Promise.resolve();
  },
  { name: 'auth' },
);
