import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/prisma.js';
import { withSystem, type Tx } from '../../src/infrastructure/db/tenant.js';
import { PrismaHealthChecker } from '../../src/modules/health/health.service.js';
import { memoryLogger, testConfig } from '../helpers.js';

/**
 * Schema-level rules. `db` connects as the least-privilege app role and works in system
 * context (RLS bypass); `owner` connects as the schema owner for catalog checks.
 * Tenant isolation itself is covered in tenancy.test.ts.
 */
const url = process.env.TEST_DATABASE_URL!;
const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL ?? url;
let db: Database;
let owner: Database;
const PREFIX = `it-${Date.now().toString(36)}`;
let seq = 0;
const slug = () => `${PREFIX}-${++seq}`;
const sys = <T>(fn: (tx: Tx) => Promise<T>) => withSystem(db, fn);

beforeAll(() => {
  db = createDatabase({ connectionString: url, max: 3 });
  owner = createDatabase({ connectionString: ownerUrl, max: 2 });
});

afterAll(async () => {
  await sys((tx) => tx.property.deleteMany({ where: { organization: { slug: { startsWith: PREFIX } } } }));
  await sys((tx) => tx.organization.deleteMany({ where: { slug: { startsWith: PREFIX } } }));
  await db.$disconnect();
  await owner.$disconnect();
});

function newProperty(organizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    name: `Property ${++seq}`,
    propertyType: 'VILLA' as const,
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    countryCode: 'IN',
    ...overrides,
  };
}

describe('migrations', () => {
  it('has applied every migration in prisma/migrations', async () => {
    const dir = join(import.meta.dirname, '../../prisma/migrations');
    const expected = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const rows = await owner.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(rows.map((r) => r.migration_name).sort()).toEqual(expected.sort());
  });

  it('creates the expected tables', async () => {
    const rows = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['organizations', 'properties', 'audit_events', 'users', 'organization_memberships', 'sessions', 'recovery_codes', 'one_time_tokens']),
    );
  });

  it('stores timestamps as timestamptz', async () => {
    const rows = await owner.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('created_at', 'updated_at')`;
    expect(new Set(rows.map((r) => r.data_type))).toEqual(new Set(['timestamp with time zone']));
  });

  it('enables and forces row-level security on tenant tables', async () => {
    const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('organizations', 'properties', 'organization_memberships', 'audit_events')`;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });

  it('runs the API as a role that is not superuser, not owner and cannot bypass RLS', async () => {
    const [role] = await db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }[]>`
      SELECT r.rolsuper, r.rolbypassrls,
             EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owns
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
  });
});

describe('constraints', () => {
  it('generates time-ordered UUIDv7 ids', async () => {
    const org = await sys((tx) => tx.organization.create({ data: { name: 'UUID Org', slug: slug() } }));
    expect(org.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('enforces unique organization slugs', async () => {
    const s = slug();
    await sys((tx) => tx.organization.create({ data: { name: 'A', slug: s } }));
    await expect(sys((tx) => tx.organization.create({ data: { name: 'B', slug: s } }))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects malformed slugs and currencies at the database level', async () => {
    await expect(sys((tx) => tx.organization.create({ data: { name: 'Bad', slug: 'Has Spaces' } }))).rejects.toThrow(/organizations_slug_format_chk/);
    await expect(sys((tx) => tx.organization.create({ data: { name: 'Bad', slug: slug(), defaultCurrency: 'inr' } }))).rejects.toThrow(
      /organizations_currency_format_chk/,
    );
  });

  it('enforces unique property names within an organization but not across organizations', async () => {
    const a = await sys((tx) => tx.organization.create({ data: { name: 'A', slug: slug() } }));
    const b = await sys((tx) => tx.organization.create({ data: { name: 'B', slug: slug() } }));
    await sys((tx) => tx.property.create({ data: newProperty(a.id, { name: 'Same Name' }) }));
    await sys((tx) => tx.property.create({ data: newProperty(b.id, { name: 'Same Name' }) }));
    await expect(sys((tx) => tx.property.create({ data: newProperty(a.id, { name: 'Same Name' }) }))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects unknown IANA time zones', async () => {
    const org = await sys((tx) => tx.organization.create({ data: { name: 'TZ', slug: slug() } }));
    await expect(sys((tx) => tx.property.create({ data: newProperty(org.id, { timezone: 'Mars/Olympus_Mons' }) }))).rejects.toThrow(/invalid time zone/);
    const ok = await sys((tx) => tx.property.create({ data: newProperty(org.id, { timezone: 'Europe/Lisbon' }) }));
    expect(ok.timezone).toBe('Europe/Lisbon');
  });

  it('rejects malformed check-in times', async () => {
    const org = await sys((tx) => tx.organization.create({ data: { name: 'Times', slug: slug() } }));
    await expect(sys((tx) => tx.property.create({ data: newProperty(org.id, { checkInTime: '25:00' }) }))).rejects.toThrow(/check_in_format/);
  });

  it('prevents deleting an organization that still owns properties', async () => {
    const org = await sys((tx) => tx.organization.create({ data: { name: 'Owner', slug: slug() } }));
    await sys((tx) => tx.property.create({ data: newProperty(org.id) }));
    await expect(sys((tx) => tx.organization.delete({ where: { id: org.id } }))).rejects.toBeTruthy();
  });

  it('rejects properties pointing at a non-existent organization', async () => {
    await expect(sys((tx) => tx.property.create({ data: newProperty('01900000-0000-7000-8000-000000000000') }))).rejects.toBeTruthy();
  });

  it('requires normalized user emails', async () => {
    await expect(
      sys((tx) => tx.user.create({ data: { email: 'Mixed@Example.TEST', displayName: 'X', passwordHash: 'x' } })),
    ).rejects.toThrow(/users_email_normalized_chk/);
  });
});

describe('audit log', () => {
  it('is append-only for the app role (no UPDATE/DELETE privilege)', async () => {
    const ev = await sys((tx) => tx.auditEvent.create({ data: { action: 'test.audit_immutability', metadata: { test: true } } }));
    await expect(sys((tx) => tx.auditEvent.update({ where: { id: ev.id }, data: { action: 'tampered' } }))).rejects.toThrow(/permission denied|append-only/);
    await expect(sys((tx) => tx.auditEvent.delete({ where: { id: ev.id } }))).rejects.toThrow(/permission denied|append-only/);
    const still = await sys((tx) => tx.auditEvent.findUnique({ where: { id: ev.id } }));
    expect(still?.action).toBe('test.audit_immutability');
  });

  it('is append-only even for the schema owner (trigger)', async () => {
    const ev = await withSystem(owner, (tx) => tx.auditEvent.create({ data: { action: 'test.owner_immutability' } }));
    await expect(withSystem(owner, (tx) => tx.auditEvent.update({ where: { id: ev.id }, data: { action: 'x' } }))).rejects.toThrow(/append-only/);
    await expect(withSystem(owner, (tx) => tx.auditEvent.delete({ where: { id: ev.id } }))).rejects.toThrow(/append-only/);
    await expect(owner.$executeRawUnsafe('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });
});

describe('transactions', () => {
  it('rolls back every write when any statement in the transaction fails', async () => {
    const s = slug();
    await expect(
      sys(async (tx) => {
        const org = await tx.organization.create({ data: { name: 'Tx', slug: s } });
        await tx.property.create({ data: newProperty(org.id, { name: 'Tx Property' }) });
        await tx.property.create({ data: newProperty(org.id, { timezone: 'Not/AZone' }) });
      }),
    ).rejects.toThrow();
    expect(await sys((tx) => tx.organization.findUnique({ where: { slug: s } }))).toBeNull();
  });

  it('commits when all statements succeed', async () => {
    const s = slug();
    await sys(async (tx) => {
      const org = await tx.organization.create({ data: { name: 'Tx OK', slug: s } });
      await tx.property.create({ data: newProperty(org.id) });
    });
    const org = await sys((tx) => tx.organization.findUnique({ where: { slug: s }, include: { properties: true } }));
    expect(org?.properties).toHaveLength(1);
  });
});

describe('health against a real database', () => {
  it('reports the database as up', async () => {
    const status = await new PrismaHealthChecker(db).checkDatabase();
    expect(status.status).toBe('up');
  });

  it('reports the database as down for an unreachable server without throwing', async () => {
    const broken = createDatabase({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 1000 });
    const status = await new PrismaHealthChecker(broken, 1500).checkDatabase();
    expect(status.status).toBe('down');
    await broken.$disconnect();
  });

  it('GET /api/v1/health/ready returns ready', async () => {
    const { logger } = memoryLogger();
    const app = createApp({ config: testConfig(), logger, health: new PrismaHealthChecker(db) });
    const res = await request(app).get('/api/v1/health/ready').expect(200);
    expect(res.body.data.checks.database.status).toBe('up');
  });
});
