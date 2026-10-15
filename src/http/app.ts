import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Env } from '../config/env.js';
import type { Clock } from '../lib/clock.js';
import type { TokenSigner } from '../lib/tokens.js';
import type { Database } from '../repositories/index.js';
import type { Services } from '../services/index.js';
import { authPlugin } from './plugins/auth.js';
import { problemErrorHandler, problemNotFoundHandler } from './problem.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { availabilityRoutes } from './routes/availability.js';
import { catalogRoutes } from './routes/catalog.js';
import { customerRoutes } from './routes/customers.js';
import { healthRoutes } from './routes/health.js';
import { organizationRoutes } from './routes/organization.js';
import { staffRoutes } from './routes/staff.js';

export interface AppDeps {
  env: Env;
  db: Database;
  services: Services;
  signer: TokenSigner;
  clock: Clock;
  logger?: FastifyServerOptions['logger'];
}

const REQUEST_ID = /^[\w.-]{1,128}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, services } = deps;

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: env.TRUST_PROXY,
    requestIdHeader: false,
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(problemErrorHandler);
  app.setNotFoundHandler(problemNotFoundHandler);
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    done(null, payload);
  });

  await app.register(helmet);
  if (env.CORS_ORIGINS.length > 0) {
    await app.register(cors, {
      origin: env.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
    });
  }
  await app.register(rateLimit, { global: false });

  if (env.DOCS_ENABLED) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'appointments-api',
          version: '0.1.0',
          description: 'Appointment booking for small service businesses.',
          license: { name: 'MIT', identifier: 'MIT' },
        },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        },
      },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  await app.register(authPlugin, { signer: deps.signer, auth: services.auth });
  await app.register(healthRoutes, { db: deps.db });
  await app.register(authRoutes, {
    services,
    rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, windowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS },
  });
  for (const routes of [
    organizationRoutes,
    catalogRoutes,
    staffRoutes,
    customerRoutes,
    availabilityRoutes,
    appointmentRoutes,
  ]) {
    await app.register(routes, { services });
  }

  return app;
}
