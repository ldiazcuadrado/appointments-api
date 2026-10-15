import { loadEnv } from '../src/config/env.js';
import { hashPassword } from '../src/lib/passwords.js';
import { createPrisma } from '../src/lib/prisma.js';

/**
 * Loads a fictitious business for local development. Everything here is made up:
 * the organization, the people and the example.com addresses. The script is
 * idempotent and refuses to run against production.
 */
const DEMO_PASSWORD = 'demo-password-123';

async function main(): Promise<void> {
  const env = loadEnv({
    ...process.env,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'x'.repeat(32),
  });
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');

  const prisma = createPrisma(env.DATABASE_URL);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  try {
    if (!(await prisma.organization.findFirst())) {
      await prisma.organization.create({
        data: {
          name: 'Example Wellness Studio (demo data)',
          timezone: 'America/New_York',
          minNoticeMinutes: 120,
          maxAdvanceDays: 60,
          slotGranularityMinutes: 15,
          cancellationWindowHours: 24,
        },
      });
    }

    const services = [
      { name: 'Consultation', durationMinutes: 30, bufferMinutes: 0, priceCents: 3500 },
      { name: 'Standard treatment', durationMinutes: 60, bufferMinutes: 15, priceCents: 7500 },
      { name: 'Extended treatment', durationMinutes: 90, bufferMinutes: 15, priceCents: 10500 },
    ];
    const serviceIds: string[] = [];
    for (const data of services) {
      const existing = await prisma.service.findFirst({ where: { name: data.name } });
      serviceIds.push((existing ?? (await prisma.service.create({ data }))).id);
    }

    const upsertUser = (email: string, role: 'admin' | 'staff' | 'customer') =>
      prisma.user.upsert({ where: { email }, update: {}, create: { email, passwordHash, role } });

    await upsertUser('admin@demo.example.com', 'admin');

    const team = [
      { email: 'avery@demo.example.com', displayName: 'Avery Demo' },
      { email: 'jordan@demo.example.com', displayName: 'Jordan Demo' },
    ];
    for (const member of team) {
      const user = await upsertUser(member.email, 'staff');
      const staff = await prisma.staffMember.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, displayName: member.displayName },
      });
      await prisma.staffService.createMany({
        data: serviceIds.map((serviceId) => ({ staffId: staff.id, serviceId })),
        skipDuplicates: true,
      });
      if ((await prisma.workingHours.count({ where: { staffId: staff.id } })) === 0) {
        await prisma.workingHours.createMany({
          data: [1, 2, 3, 4, 5].flatMap((weekday) => [
            { staffId: staff.id, weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
            { staffId: staff.id, weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
          ]),
        });
      }
    }

    for (const person of [
      { email: 'casey@demo.example.com', name: 'Casey Demo' },
      { email: 'riley@demo.example.com', name: 'Riley Demo' },
    ]) {
      const user = await upsertUser(person.email, 'customer');
      await prisma.customer.upsert({
        where: { email: person.email },
        update: {},
        create: { email: person.email, name: person.name, userId: user.id },
      });
    }

    console.log(`Demo data ready. Sign in as admin@demo.example.com / ${DEMO_PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
