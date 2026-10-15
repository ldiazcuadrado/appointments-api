import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../domain/policy.js';
import type { Services } from '../../services/index.js';
import { toPage, toServiceDto } from '../dto.js';
import {
  booleanQuery,
  idParam,
  paged,
  paginationQuery,
  problems,
  serviceSchema,
} from '../schemas.js';

const serviceFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  bufferMinutes: z.number().int().min(0).max(240),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  active: z.boolean(),
};

export const catalogRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/services',
    {
      schema: {
        tags: ['Services'],
        summary: 'List services',
        description: 'Admins also see inactive services when `includeInactive` is set.',
        security: [{ bearerAuth: [] }],
        querystring: paginationQuery.extend({ includeInactive: booleanQuery.default(false) }),
        response: { 200: paged(serviceSchema), ...problems(400, 401) },
      },
    },
    async (request) => {
      const { includeInactive, ...params } = request.query;
      const page = await services.catalog.list(
        params,
        includeInactive && request.actor.role === 'admin',
      );
      return toPage(page, params, toServiceDto);
    },
  );

  app.get(
    '/services/:id',
    {
      schema: {
        tags: ['Services'],
        summary: 'Get a service',
        security: [{ bearerAuth: [] }],
        params: idParam,
        response: { 200: serviceSchema, ...problems(401, 404) },
      },
    },
    async (request) => toServiceDto(await services.catalog.get(request.params.id)),
  );

  app.post(
    '/services',
    {
      schema: {
        tags: ['Services'],
        summary: 'Create a service (admin)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          ...serviceFields,
          description: serviceFields.description.optional(),
          bufferMinutes: serviceFields.bufferMinutes.default(0),
          currency: serviceFields.currency.default('USD'),
          active: serviceFields.active.default(true),
        }),
        response: { 201: serviceSchema, ...problems(400, 401, 403) },
      },
    },
    async (request, reply) => {
      requireRole(request.actor, 'admin');
      const created = await services.catalog.create(request.body);
      return reply.status(201).send(toServiceDto(created));
    },
  );

  app.patch(
    '/services/:id',
    {
      schema: {
        tags: ['Services'],
        summary: 'Update a service (admin)',
        description: 'Deactivate a service with `active: false`; existing appointments are kept.',
        security: [{ bearerAuth: [] }],
        params: idParam,
        body: z
          .object(serviceFields)
          .partial()
          .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
        response: { 200: serviceSchema, ...problems(400, 401, 403, 404) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin');
      return toServiceDto(await services.catalog.update(request.params.id, request.body));
    },
  );
};
