import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../services/index.js';
import { isoDateTime, localDate, problems } from '../schemas.js';

export const availabilityRoutes: FastifyPluginAsyncZod<{ services: Services }> = async (
  app,
  { services },
) => {
  app.get(
    '/availability',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Availability'],
        summary: 'Bookable slots for a service over a date range',
        description:
          'Dates are local calendar dates in the organization time zone and the range is inclusive, up to 31 days. Omit `staffId` to search every staff member who performs the service; each slot lists the staff available at that start time.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          serviceId: z.uuid(),
          staffId: z.uuid().optional(),
          from: localDate,
          to: localDate,
        }),
        response: {
          200: z.object({
            timezone: z.string(),
            serviceId: z.uuid(),
            slots: z.array(
              z.object({ startsAt: isoDateTime, endsAt: isoDateTime, staffIds: z.array(z.uuid()) }),
            ),
          }),
          ...problems(400, 401, 404, 422),
        },
      },
    },
    async (request) => {
      const result = await services.availability.search(request.query);
      return {
        ...result,
        slots: result.slots.map((slot) => ({
          ...slot,
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
        })),
      };
    },
  );
};
