/**
 * Seeds CLEARLY FAKE demo data for local development. Idempotent. Refuses to run in production.
 * Creates a demo organization, a property and a verified owner account whose random
 * password is printed once (no passwords are stored in source code).
 */
import 'dotenv/config';
import { createDatabase } from '../src/infrastructure/db/prisma.js';
import { withSystem } from '../src/infrastructure/db/tenant.js';
import { Argon2PasswordHasher } from '../src/modules/auth/password.js';
import { createDefaultSubscription } from '../src/modules/subscriptions/plan-limits.js';
import { randomToken } from '../src/shared/crypto.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data when NODE_ENV=production');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createDatabase({ connectionString: url, max: 2 });
const hasher = new Argon2PasswordHasher({ memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456), timeCost: Number(process.env.ARGON2_TIME_COST ?? 2) });
const OWNER_EMAIL = 'owner@demo.staysync.test';

async function seed(): Promise<void> {
  const password = `demo-${randomToken(10)}`;
  const passwordHash = await hasher.hash(password);
  const result = await withSystem(db, async (tx) => {
    const org = await tx.organization.upsert({
      where: { slug: 'demo-seaside-stays' },
      update: {},
      create: { name: 'Demo Seaside Stays (FAKE DEMO DATA)', slug: 'demo-seaside-stays', defaultCurrency: 'INR' },
    });
    if (!(await tx.subscription.findUnique({ where: { organizationId: org.id } }))) await createDefaultSubscription(tx, org.id);
    const property = await tx.property.upsert({
      where: { organizationId_name: { organizationId: org.id, name: 'Demo Sea View Villa' } },
      update: {},
      create: {
        organizationId: org.id,
        name: 'Demo Sea View Villa',
        propertyType: 'VILLA',
        status: 'DRAFT',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        countryCode: 'IN',
        city: 'Example City',
        addressLine1: '1 Demo Street (not a real address)',
        checkInTime: '14:00',
        checkOutTime: '11:00',
        description: 'FAKE DEMO PROPERTY for local development.',
        amenities: ['WIFI', 'POOL', 'PARKING', 'BEACH_ACCESS'],
      },
    });
    const roomTypes = [
      { code: 'DLX', name: 'Deluxe Room', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, rooms: ['101', '102', '103', '104', '105'] },
      { code: 'PRM', name: 'Premium Room', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, rooms: ['201', '202', '203'] },
      { code: 'VIL', name: 'Private Villa', maxAdults: 4, maxChildren: 2, maxOccupancy: 6, rooms: ['V1', 'V2'] },
    ];
    for (const [i, rt] of roomTypes.entries()) {
      const type = await tx.roomType.upsert({
        where: { propertyId_code: { propertyId: property.id, code: rt.code } },
        update: {},
        create: {
          organizationId: org.id,
          propertyId: property.id,
          code: rt.code,
          name: rt.name,
          maxAdults: rt.maxAdults,
          maxChildren: rt.maxChildren,
          maxOccupancy: rt.maxOccupancy,
          sortOrder: i,
          amenities: ['AIR_CONDITIONING', 'WIFI', 'PRIVATE_BATHROOM'],
        },
      });
      for (const name of rt.rooms) {
        await tx.room.upsert({
          where: { propertyId_name: { propertyId: property.id, name } },
          update: {},
          create: { organizationId: org.id, propertyId: property.id, roomTypeId: type.id, name },
        });
      }
    }
    const existing = await tx.user.findUnique({ where: { email: OWNER_EMAIL } });
    const user =
      existing ??
      (await tx.user.create({ data: { email: OWNER_EMAIL, displayName: 'Demo Owner', passwordHash, emailVerifiedAt: new Date() } }));
    await tx.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      update: {},
      create: { organizationId: org.id, userId: user.id, role: 'ORG_OWNER' },
    });
    await tx.auditEvent.create({ data: { organizationId: org.id, action: 'seed.demo_data_loaded', actorType: 'system', metadata: { fake: true } } });
    return { org, created: !existing };
  });

  console.log(`Seeded demo organization "${result.org.name}"`);
  if (result.created) {
    console.log(`Demo owner login: ${OWNER_EMAIL}  password (shown once): ${password}`);
  } else {
    console.log(`Demo owner ${OWNER_EMAIL} already exists (password unchanged; use "Forgot password" + Mailpit to reset).`);
  }
}

seed()
  .catch((err: unknown) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());
