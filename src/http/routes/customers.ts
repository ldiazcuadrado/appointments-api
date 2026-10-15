import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { forbidden } from '../../domain/errors.js';
import { requireRole } from '../../domain/policy.js';
import type { Services } from '../../services/index.js';
import { toCustomerDto, toPage } from '../dto.js';
import { customerSchema, idParam, paged, paginationQuery, problems } from '../schemas.js';

const fields = {
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  phone: z.string().trim().min(3).max(30).nullable(),
};

export const customerRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', app.authenticate);
  const security = [{ bearerAuth: [] }];

  app.get(
    '/customers',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Search customers (admin, staff)',
        security,
        querystring: paginationQuery.extend({ q: z.string().trim().min(1).max(100).optional() }),
        response: { 200: paged(customerSchema), ...problems(400, 401, 403) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin', 'staff');
      const { q, ...params } = request.query;
      return toPage(await services.customers.list(params, q), params, toCustomerDto);
    },
  );

  app.post(
    '/customers',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Create a customer record without a login (admin, staff)',
        security,
        body: z.object({ ...fields, phone: fields.phone.optional() }),
        response: { 201: customerSchema, ...problems(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      requireRole(request.actor, 'admin', 'staff');
      return reply.status(201).send(toCustomerDto(await services.customers.create(request.body)));
    },
  );

  app.get(
    '/customers/:id',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Get a customer (staff side, or the customer themself)',
        security,
        params: idParam,
        response: { 200: customerSchema, ...problems(401, 403, 404) },
      },
    },
    async (request) =>
      toCustomerDto(await services.customers.get(request.actor, request.params.id)),
  );

  app.patch(
    '/customers/:id',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Update a customer (staff side, or the customer themself, except the email)',
        security,
        params: idParam,
        body: z
          .object(fields)
          .partial()
          .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
        response: { 200: customerSchema, ...problems(400, 401, 403, 404, 409) },
      },
    },
    async (request) => {
      if (request.actor.role === 'customer' && request.body.email !== undefined) {
        throw forbidden('Customers cannot change their email address');
      }
      return toCustomerDto(
        await services.customers.update(request.actor, request.params.id, request.body),
      );
    },
  );
};
