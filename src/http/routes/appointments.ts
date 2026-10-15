import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { APPOINTMENT_STATUSES } from '../../domain/types.js';
import type { Services } from '../../services/index.js';
import { toAppointmentDto, toPage } from '../dto.js';
import {
  appointmentSchema,
  idParam,
  isoDateTime,
  paged,
  paginationQuery,
  problems,
} from '../schemas.js';

export const appointmentRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', app.authenticate);
  const security = [{ bearerAuth: [] }];

  app.post(
    '/appointments',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Book an appointment',
        description:
          'Customers book for themselves; staff and admins must pass `customerId`. Omit `staffId` to let the API pick an available staff member. Send an `Idempotency-Key` header to make retries safe: a repeated request with the same key and body returns the original appointment with `Idempotent-Replayed: true`.',
        security,
        headers: z.object({ 'idempotency-key': z.string().min(1).max(255).optional() }),
        body: z.object({
          serviceId: z.uuid(),
          staffId: z.uuid().optional(),
          customerId: z.uuid().optional(),
          startsAt: isoDateTime,
          notes: z.string().trim().max(1000).optional(),
        }),
        response: { 201: appointmentSchema, ...problems(400, 401, 403, 404, 409, 422) },
      },
    },
    async (request, reply) => {
      const { startsAt, ...rest } = request.body;
      const { appointment, replayed } = await services.appointments.create(
        request.actor,
        { ...rest, startsAt: new Date(startsAt) },
        request.headers['idempotency-key'],
      );
      if (replayed) void reply.header('idempotent-replayed', 'true');
      return reply.status(201).send(toAppointmentDto(appointment));
    },
  );

  app.get(
    '/appointments',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'List appointments visible to the caller',
        description:
          'Customers see their own appointments, staff their own schedule, admins everything. `from` is inclusive and `to` exclusive, compared against the start time.',
        security,
        querystring: paginationQuery.extend({
          status: z.enum(APPOINTMENT_STATUSES).optional(),
          staffId: z.uuid().optional(),
          customerId: z.uuid().optional(),
          serviceId: z.uuid().optional(),
          from: isoDateTime.optional(),
          to: isoDateTime.optional(),
        }),
        response: { 200: paged(appointmentSchema), ...problems(400, 401) },
      },
    },
    async (request) => {
      const { from, to, status, staffId, customerId, serviceId, ...params } = request.query;
      const page = await services.appointments.list(request.actor, params, {
        ...(status ? { status } : {}),
        ...(staffId ? { staffId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(from ? { from: new Date(from) } : {}),
        ...(to ? { to: new Date(to) } : {}),
      });
      return toPage(page, params, toAppointmentDto);
    },
  );

  app.get(
    '/appointments/:id',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Get an appointment',
        security,
        params: idParam,
        response: { 200: appointmentSchema, ...problems(401, 403, 404) },
      },
    },
    async (request) =>
      toAppointmentDto(await services.appointments.get(request.actor, request.params.id)),
  );

  app.post(
    '/appointments/:id/cancel',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Cancel an appointment',
        description:
          'Customers can cancel until the organization cancellation window opens; staff and admins can cancel any time before the start.',
        security,
        params: idParam,
        body: z.object({ reason: z.string().trim().max(500).optional() }).default({}),
        response: { 200: appointmentSchema, ...problems(401, 403, 404, 409, 422) },
      },
    },
    async (request) =>
      toAppointmentDto(
        await services.appointments.cancel(request.actor, request.params.id, request.body.reason),
      ),
  );

  app.post(
    '/appointments/:id/reschedule',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Move an appointment to another slot',
        description:
          'Subject to the same cancellation window as customer cancellations. Staff and admins may also pass `staffId` to reassign.',
        security,
        params: idParam,
        body: z.object({ startsAt: isoDateTime, staffId: z.uuid().optional() }),
        response: { 200: appointmentSchema, ...problems(400, 401, 403, 404, 409, 422) },
      },
    },
    async (request) =>
      toAppointmentDto(
        await services.appointments.reschedule(request.actor, request.params.id, {
          startsAt: new Date(request.body.startsAt),
          staffId: request.body.staffId,
        }),
      ),
  );

  app.post(
    '/appointments/:id/status',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Confirm, complete, or mark an appointment as a no-show (admin, staff)',
        security,
        params: idParam,
        body: z.object({ status: z.enum(['confirmed', 'completed', 'no_show']) }),
        response: { 200: appointmentSchema, ...problems(401, 403, 404, 409, 422) },
      },
    },
    async (request) =>
      toAppointmentDto(
        await services.appointments.setStatus(
          request.actor,
          request.params.id,
          request.body.status,
        ),
      ),
  );

  app.get(
    '/appointments/:id/ics',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Download the appointment as an iCalendar file',
        security,
        params: idParam,
        response: { 200: z.string(), ...problems(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const { filename, content } = await services.appointments.calendarEntry(
        request.actor,
        request.params.id,
      );
      return reply
        .type('text/calendar; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(content);
    },
  );
};
