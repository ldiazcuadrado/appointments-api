import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clockToMinutes } from '../../domain/booking-rules.js';
import { forbidden } from '../../domain/errors.js';
import { requireRole } from '../../domain/policy.js';
import type { Services } from '../../services/index.js';
import { toPage, toStaffDto, toTimeOffDto, toWorkingHoursDto } from '../dto.js';
import {
  booleanQuery,
  idParam,
  isoDateTime,
  paged,
  paginationQuery,
  problems,
  staffSchema,
  timeOffSchema,
  workingHoursSchema,
} from '../schemas.js';

export const staffRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', app.authenticate);
  const security = [{ bearerAuth: [] }];

  app.get(
    '/staff',
    {
      schema: {
        tags: ['Staff'],
        summary: 'List staff members',
        security,
        querystring: paginationQuery.extend({
          serviceId: z.uuid().optional(),
          includeInactive: booleanQuery.default(false),
        }),
        response: { 200: paged(staffSchema), ...problems(400, 401) },
      },
    },
    async (request) => {
      const { includeInactive, serviceId, ...params } = request.query;
      const page = await services.staff.list(params, {
        includeInactive: includeInactive && request.actor.role === 'admin',
        serviceId,
      });
      return toPage(page, params, toStaffDto);
    },
  );

  app.get(
    '/staff/:id',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Get a staff member',
        security,
        params: idParam,
        response: { 200: staffSchema, ...problems(401, 404) },
      },
    },
    async (request) => toStaffDto(await services.staff.get(request.params.id)),
  );

  app.post(
    '/staff',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Create a staff member with a login (admin)',
        security,
        body: z.object({
          displayName: z.string().trim().min(1).max(120),
          email: z.email().max(254),
          password: z.string().min(8).max(128),
        }),
        response: { 201: staffSchema, ...problems(400, 401, 403, 409) },
      },
    },
    async (request, reply) => {
      requireRole(request.actor, 'admin');
      return reply.status(201).send(toStaffDto(await services.staff.create(request.body)));
    },
  );

  app.patch(
    '/staff/:id',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Update a staff member (admin)',
        security,
        params: idParam,
        body: z
          .object({ displayName: z.string().trim().min(1).max(120), active: z.boolean() })
          .partial()
          .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
        response: { 200: staffSchema, ...problems(400, 401, 403, 404) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin');
      return toStaffDto(await services.staff.update(request.params.id, request.body));
    },
  );

  app.put(
    '/staff/:id/services',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Replace the services a staff member performs (admin)',
        security,
        params: idParam,
        body: z.object({ serviceIds: z.array(z.uuid()).max(200) }),
        response: { 200: staffSchema, ...problems(400, 401, 403, 404) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin');
      return toStaffDto(
        await services.staff.setServices(request.params.id, request.body.serviceIds),
      );
    },
  );

  app.get(
    '/staff/:id/working-hours',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Weekly schedule, in the organization time zone',
        security,
        params: idParam,
        response: { 200: z.array(workingHoursSchema), ...problems(401, 404) },
      },
    },
    async (request) =>
      (await services.staff.getWorkingHours(request.params.id)).map(toWorkingHoursDto),
  );

  app.put(
    '/staff/:id/working-hours',
    {
      schema: {
        tags: ['Staff'],
        summary: 'Replace the weekly schedule (admin or the staff member)',
        description:
          'Multiple intervals per weekday express breaks. Times are wall-clock in the organization time zone; `24:00` ends at midnight.',
        security,
        params: idParam,
        body: z.object({ intervals: z.array(workingHoursSchema).max(70) }),
        response: { 200: z.array(workingHoursSchema), ...problems(400, 401, 403, 404) },
      },
    },
    async (request) => {
      const intervals = request.body.intervals.map((i) => ({
        weekday: i.weekday,
        startMinute: clockToMinutes(i.start),
        endMinute: clockToMinutes(i.end),
      }));
      const saved = await services.staff.setWorkingHours(
        request.actor,
        request.params.id,
        intervals,
      );
      return saved.map(toWorkingHoursDto);
    },
  );

  app.get(
    '/time-off',
    {
      schema: {
        tags: ['Time off'],
        summary: 'List time off and closures (admin, staff)',
        security,
        querystring: z.object({
          staffId: z.uuid().optional(),
          from: isoDateTime.optional(),
          to: isoDateTime.optional(),
        }),
        response: { 200: z.array(timeOffSchema), ...problems(400, 401, 403) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin', 'staff');
      const { staffId, from, to } = request.query;
      const entries = await services.staff.listTimeOff({
        staffId,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      });
      return entries.map(toTimeOffDto);
    },
  );

  app.post(
    '/time-off',
    {
      schema: {
        tags: ['Time off'],
        summary: 'Block time for a staff member, or for everyone with a null staffId',
        description:
          'Admins may block anyone; staff only themselves. Organization-wide closures are admin only.',
        security,
        body: z.object({
          staffId: z.uuid().nullable(),
          startsAt: isoDateTime,
          endsAt: isoDateTime,
          reason: z.string().trim().max(200).optional(),
        }),
        response: { 201: timeOffSchema, ...problems(400, 401, 403, 404) },
      },
    },
    async (request, reply) => {
      if (request.actor.role === 'customer') throw forbidden();
      const { startsAt, endsAt, ...rest } = request.body;
      const created = await services.staff.createTimeOff(request.actor, {
        ...rest,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      });
      return reply.status(201).send(toTimeOffDto(created));
    },
  );

  app.delete(
    '/time-off/:id',
    {
      schema: {
        tags: ['Time off'],
        summary: 'Remove a time off entry',
        security,
        params: idParam,
        response: { 204: z.null(), ...problems(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await services.staff.deleteTimeOff(request.actor, request.params.id);
      return reply.status(204).send(null);
    },
  );
};
