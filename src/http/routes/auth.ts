import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../services/index.js';
import { toUserDto } from '../dto.js';
import { problems, tokenPairSchema, userSchema } from '../schemas.js';

export interface AuthRouteOptions {
  services: Services;
  rateLimit: { max: number; windowSeconds: number };
}

const credentials = {
  email: z.email().max(254),
  password: z.string().min(8).max(128),
};

const sessionSchema = z.object({ user: userSchema, tokens: tokenPairSchema });

export const authRoutes: FastifyPluginAsyncZod<AuthRouteOptions> = async (
  app,
  { services, rateLimit },
) => {
  const limited = { rateLimit: { max: rateLimit.max, timeWindow: rateLimit.windowSeconds * 1000 } };

  app.post(
    '/auth/register',
    {
      config: limited,
      schema: {
        tags: ['Auth'],
        summary: 'Create a customer account',
        body: z.object({
          ...credentials,
          name: z.string().trim().min(1).max(120),
          phone: z.string().trim().min(3).max(30).optional(),
        }),
        response: { 201: sessionSchema, ...problems(400, 409) },
      },
    },
    async (request, reply) => {
      const { user, tokens } = await services.auth.register(request.body);
      return reply.status(201).send({ user: toUserDto(user), tokens });
    },
  );

  app.post(
    '/auth/login',
    {
      config: limited,
      schema: {
        tags: ['Auth'],
        summary: 'Exchange credentials for an access and refresh token',
        body: z.object({ email: credentials.email, password: z.string().min(1).max(128) }),
        response: { 200: sessionSchema, ...problems(400, 401) },
      },
    },
    async (request) => {
      const { user, tokens } = await services.auth.login(request.body.email, request.body.password);
      return { user: toUserDto(user), tokens };
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: limited,
      schema: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token',
        description:
          'The presented token is revoked and a new pair is returned. Reusing a revoked token revokes the whole session.',
        body: z.object({ refreshToken: z.string().min(1).max(256) }),
        response: { 200: tokenPairSchema, ...problems(400, 401) },
      },
    },
    (request) => services.auth.refresh(request.body.refreshToken),
  );

  app.post(
    '/auth/logout',
    {
      config: limited,
      schema: {
        tags: ['Auth'],
        summary: 'Revoke a refresh token and its session',
        body: z.object({ refreshToken: z.string().min(1).max(256) }),
        response: { 204: z.null(), ...problems(400) },
      },
    },
    async (request, reply) => {
      await services.auth.logout(request.body.refreshToken);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Auth'],
        summary: 'Current account',
        security: [{ bearerAuth: [] }],
        response: { 200: userSchema, ...problems(401) },
      },
    },
    async (request) => toUserDto((await services.auth.actorFor(request.actor.userId)).user),
  );
};
