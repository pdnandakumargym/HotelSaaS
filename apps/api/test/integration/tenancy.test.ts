import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '../../src/infrastructure/db/tenant.js';
import { totpAt } from '../../src/modules/auth/totp.js';
import { createHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let orgA: string;
let orgB: string;
let propA: string;
let propB: string;
const users: Record<string, { email: string; password: string; client?: Client }> = {};

async function signIn(key: string): Promise<Client> {
  const u = users[key]!;
  if (!u.client) {
    u.client = h.client();
    const res = await u.client.login(u.email, u.password);
    expect(res.status).toBe(200);
  }
  return u.client;
}

function property(organizationId: string, name: string) {
  return { organizationId, name, propertyType: 'HOTEL' as const, timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' };
}

beforeAll(async () => {
  h = await createHarness();
  const ownerA = await h.createUser();
  const ownerB = await h.createUser();
  orgA = ownerA.organizationId!;
  orgB = ownerB.organizationId!;
  users['ownerA'] = ownerA;
  users['ownerB'] = ownerB;
  users['managerA'] = await h.createUser({ role: 'PROPERTY_MANAGER', organizationId: orgA });
  users['staffA'] = await h.createUser({ role: 'PROPERTY_STAFF', organizationId: orgA });
  users['viewerA'] = await h.createUser({ role: 'READ_ONLY', organizationId: orgA });
  users['admin'] = await h.createUser({ platformRole: 'PLATFORM_SUPER_ADMIN' });
  users['support'] = await h.createUser({ platformRole: 'PLATFORM_SUPPORT' });
  propA = (await withSystem(h.db, (tx) => tx.property.create({ data: property(orgA, 'Alpha Resort') }))).id;
  propB = (await withSystem(h.db, (tx) => tx.property.create({ data: property(orgB, 'Bravo Villa') }))).id;
});

afterAll(async () => {
  await h.close();
});

describe('cross-tenant access via the API', () => {
  it('lets an owner read their own organization and properties', async () => {
    const c = await signIn('ownerA');
    expect((await c.get(`/organizations/${orgA}`)).status).toBe(200);
    const props = await c.get(`/organizations/${orgA}/properties`);
    expect(props.status).toBe(200);
    expect(props.body.data.map((p: { id: string }) => p.id)).toEqual([propA]);
    expect(props.body.meta).toMatchObject({ page: 1, total: 1 });
  });

  it.each([
    ['', 'organization'],
    ['/properties', 'properties'],
    ['/members', 'members'],
    ['/audit-events', 'audit events'],
  ])('returns 404 (not 403) for another tenant%s (%s)', async (suffix) => {
    const c = await signIn('ownerA');
    const res = await c.get(`/organizations/${orgB}${suffix}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Bravo');
  });

  it('cannot change another tenant’s security policy', async () => {
    const c = await signIn('ownerA');
    expect((await c.send('patch', `/organizations/${orgB}/security`, { twoFactorRequired: true })).status).toBe(404);
    const b = await withSystem(h.db, (tx) => tx.organization.findUniqueOrThrow({ where: { id: orgB } }));
    expect(b.twoFactorRequired).toBe(false);
  });

  it('returns 404 for malformed organization ids', async () => {
    const c = await signIn('ownerA');
    expect((await c.get('/organizations/not-a-uuid/properties')).status).toBe(404);
  });

  it('lists only my organizations', async () => {
    const c = await signIn('ownerA');
    const res = await c.get('/organizations');
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([orgA]);
  });

  it('does not give platform administrators implicit access to tenant data', async () => {
    const c = h.client();
    await c.login(users['admin']!.email, users['admin']!.password);
    const setup = await c.post('/auth/2fa/setup');
    await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
    expect((await c.get('/admin/overview')).status).toBe(200);
    expect((await c.get(`/organizations/${orgA}/properties`)).status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await h.client().get(`/organizations/${orgA}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('role-based access control', () => {
  const matrix: [string, string, 'get' | 'patch', number][] = [
    ['managerA', '/properties', 'get', 200],
    ['staffA', '/properties', 'get', 200],
    ['viewerA', '/properties', 'get', 200],
    ['managerA', '/members', 'get', 200],
    ['staffA', '/members', 'get', 403],
    ['viewerA', '/members', 'get', 403],
    ['ownerA', '/audit-events', 'get', 200],
    ['managerA', '/audit-events', 'get', 403],
    ['viewerA', '/audit-events', 'get', 403],
    ['managerA', '/security', 'patch', 403],
    ['viewerA', '/security', 'patch', 403],
  ];
  it.each(matrix)('%s %s (%s) -> %i', async (who, path, method, expected) => {
    const c = await signIn(who);
    const res = method === 'get' ? await c.get(`/organizations/${orgA}${path}`) : await c.send('patch', `/organizations/${orgA}${path}`, { twoFactorRequired: false });
    expect(res.status).toBe(expected);
  });

  it('exposes permissions per membership in /auth/me', async () => {
    const c = await signIn('viewerA');
    const me = await c.get('/auth/me');
    expect(me.body.data.memberships[0].role).toBe('READ_ONLY');
    expect(me.body.data.memberships[0].permissions).toEqual(['org.read', 'property.read', 'booking.read']);
    expect(me.body.data.platformPermissions).toEqual([]);
  });

  it('forbids admin endpoints for organization owners', async () => {
    const c = await signIn('ownerA');
    const res = await c.get('/admin/overview');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('limits platform support to read-only admin endpoints', async () => {
    const c = h.client();
    await c.login(users['support']!.email, users['support']!.password);
    const setup = await c.post('/auth/2fa/setup');
    await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
    expect((await c.get('/admin/organizations')).status).toBe(200);
    expect((await c.get('/admin/audit-events')).status).toBe(403);
    const target = (await withSystem(h.db, (tx) => tx.user.findFirstOrThrow({ where: { email: users['viewerA']!.email } }))).id;
    expect((await c.post(`/admin/users/${target}/unlock`)).status).toBe(403);
  });

  it('admin organization list exposes counts, not tenant records', async () => {
    const c = h.client();
    const admin = await h.createUser({ platformRole: 'PLATFORM_SUPER_ADMIN' });
    await c.login(admin.email, admin.password);
    const setup = await c.post('/auth/2fa/setup');
    await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
    const res = await c.get(`/admin/organizations?pageSize=100`);
    expect(res.status).toBe(200);
    const a = res.body.data.find((o: { id: string }) => o.id === orgA);
    expect(a).toMatchObject({ propertyCount: 1 });
    expect(JSON.stringify(res.body)).not.toContain('Alpha Resort');
  });
});

describe('PostgreSQL row-level security (defense in depth)', () => {
  it('returns only the current tenant’s rows even when the query asks for another tenant', async () => {
    const rows = await withTenant(h.db, orgA, (tx) => tx.property.findMany({ where: { organizationId: orgB } }));
    expect(rows).toEqual([]);
    const all = await withTenant(h.db, orgA, (tx) => tx.property.findMany());
    expect(all.map((p) => p.id)).toEqual([propA]);
  });

  it('blocks inserting rows for another tenant', async () => {
    await expect(withTenant(h.db, orgA, (tx) => tx.property.create({ data: property(orgB, 'Smuggled') }))).rejects.toThrow(/row-level security/);
  });

  it('blocks updating or deleting another tenant’s rows', async () => {
    const updated = await withTenant(h.db, orgA, (tx) => tx.property.updateMany({ where: { id: propB }, data: { name: 'Hijacked' } }));
    expect(updated.count).toBe(0);
    const deleted = await withTenant(h.db, orgA, (tx) => tx.property.deleteMany({ where: { id: propB } }));
    expect(deleted.count).toBe(0);
    const b = await withSystem(h.db, (tx) => tx.property.findUniqueOrThrow({ where: { id: propB } }));
    expect(b.name).toBe('Bravo Villa');
  });

  it('fails closed: without a tenant context no tenant rows are visible', async () => {
    expect(await h.db.property.findMany({ where: { id: { in: [propA, propB] } } })).toEqual([]);
    expect(await h.db.organization.findMany({ where: { id: { in: [orgA, orgB] } } })).toEqual([]);
  });

  it('scopes memberships and organizations too', async () => {
    const memberships = await withTenant(h.db, orgA, (tx) => tx.organizationMembership.findMany());
    expect(memberships.every((m) => m.organizationId === orgA)).toBe(true);
    const orgs = await withTenant(h.db, orgA, (tx) => tx.organization.findMany({ where: { id: { in: [orgA, orgB] } } }));
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it('tenant context does not leak between transactions (settings are transaction-local)', async () => {
    await withTenant(h.db, orgA, (tx) => tx.property.findMany());
    expect(await h.db.property.findMany({ where: { id: propA } })).toEqual([]);
  });

  it('rejects a non-UUID tenant id before touching the database', () => {
    expect(() => withTenant(h.db, "x' OR 1=1 --", (tx) => tx.property.findMany())).toThrow(/UUID/);
  });
});
