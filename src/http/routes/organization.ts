import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../domain/policy.js';
import type { Services } from '../../services/index.js';
import { toOrganizationDto } from '../dto.js';
import { organizationSchema, problems } from '../schemas.js';

export const organizationRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/organization',
    {
      schema: {
        tags: ['Organization'],
        summary: 'Business settings and booking rules',
        security: [{ bearerAuth: [] }],
        response: { 200: organizationSchema, ...problems(401, 404) },
      },
    },
    async () => toOrganizationDto(await services.organization.get()),
  );

  app.patch(
    '/organization',
    {
      schema: {
        tags: ['Organization'],
        summary: 'Update business settings (admin)',
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            name: z.string().trim().min(1).max(120),
            timezone: z.string().min(1).max(64),
            minNoticeMinutes: z
              .number()
              .int()
              .min(0)
              .max(60 * 24 * 30),
            maxAdvanceDays: z.number().int().min(1).max(730),
            slotGranularityMinutes: z.number().int().min(5).max(240),
            cancellationWindowHours: z
              .number()
              .int()
              .min(0)
              .max(24 * 30),
            autoConfirm: z.boolean(),
          })
          .partial()
          .refine((value) => Object.keys(value).length > 0, 'At least one field is required'),
        response: { 200: organizationSchema, ...problems(400, 401, 403) },
      },
    },
    async (request) => {
      requireRole(request.actor, 'admin');
      return toOrganizationDto(await services.organization.update(request.body));
    },
  );
};
