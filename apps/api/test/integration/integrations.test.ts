import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { totpAt } from '../../src/modules/auth/totp.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { createHarness, type Client, type Harness } from './harness.js';

/**
 * Zodomus is replaced by a scripted fake network here. No test can reach the real API,
 * so no test can ever change real inventory.
 */
const API_USER = 'fake-zodomus-user-abc';
const API_PASS = 'fake-zodomus-pass-xyz';
const ZODOMUS_ENV = { ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: API_USER, ZODOMUS_API_PASSWORD: API_PASS, ZODOMUS_BASE_URL: 'https://zodomus.fake.test' };

type Reply = { status: number; body?: unknown };
const script: Record<string, Reply[]> = {};
const seenPaths: string[] = [];
const fakeFetch: FetchLike = (url) => {
  const path = new URL(url).pathname;
  seenPaths.push(path);
  const reply = script[path]?.shift() ?? { status: 404, body: { error: 'unexpected path in test' } };
  return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } }));
};

let h: Harness;
let off: Harness;
let superAdmin: Client;
let support: Client;
let owner: Client;
let orgId: string;

async function adminClient(harness: Harness, role: 'PLATFORM_SUPER_ADMIN' | 'PLATFORM_SUPPORT') {
  const a = await harness.createUser({ platformRole: role });
  const c = harness.client();
  await c.login(a.email, a.password);
  const setup = await c.post('/auth/2fa/setup');
  await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
  return c;
}

beforeAll(async () => {
  h = await createHarness(ZODOMUS_ENV, { channelFetch: fakeFetch });
  off = await createHarness(); // Zodomus disabled (default)
  superAdmin = await adminClient(h, 'PLATFORM_SUPER_ADMIN');
  support = await adminClient(h, 'PLATFORM_SUPPORT');
  const o = await h.createUser();
  orgId = o.organizationId!;
  owner = h.client();
  await owner.login(o.email, o.password);
  // Test database only: start the health window from a clean slate.
  await withSystem(h.db, (tx) => tx.integrationCallLog.deleteMany({}));
});
afterAll(async () => {
  await h.close();
  await off.close();
});
beforeEach(() => {
  for (const k of Object.keys(script)) delete script[k];
});

describe('integration status when Zodomus is disabled', () => {
  it('reports not configured and refuses Test Connection with 409 (no network call)', async () => {
    const admin = await adminClient(off, 'PLATFORM_SUPER_ADMIN');
    const status = await admin.get('/admin/integrations/zodomus');
    expect(status.status).toBe(200);
    expect(status.body.data.config).toMatchObject({ enabled: false, credentialsConfigured: false });
    expect(status.body.data.health).toMatchObject({ connection: 'disabled', credentials: 'not_configured' });
    const test = await admin.post('/admin/integrations/zodomus/test');
    expect(test.status).toBe(409);
    expect(test.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });
});

describe('Zodomus Test Connection and API health', () => {
  it('starts untested, with credentials unverified', async () => {
    const res = await superAdmin.get('/admin/integrations/zodomus');
    expect(res.body.data.config).toMatchObject({ enabled: true, environment: 'sandbox', credentialsConfigured: true });
    expect(res.body.data.health).toMatchObject({ connection: 'untested', credentials: 'unverified' });
  });

  it('marks credentials rejected after a 401 and shows a safe error', async () => {
    script['/account'] = [{ status: 401, body: { message: 'bad credentials for fake-zodomus-user-abc' } }];
    const res = await superAdmin.post('/admin/integrations/zodomus/test');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, outcome: 'AUTH_ERROR', httpStatus: 401 });
    expect(JSON.stringify(res.body)).not.toContain(API_USER);
    const status = await superAdmin.get('/admin/integrations/zodomus');
    expect(status.body.data.health).toMatchObject({ connection: 'failing', credentials: 'rejected' });
  });

  it('marks the connection verified after a successful GET /account', async () => {
    script['/account'] = [{ status: 200, body: { account: { name: 'Fake Account' } } }];
    const res = await superAdmin.post('/admin/integrations/zodomus/test');
    expect(res.body.data).toMatchObject({ ok: true, outcome: 'SUCCESS', operation: 'account' });
    expect(res.body.data.data).toBeUndefined(); // Test Connection returns no provider data
    const status = await superAdmin.get('/admin/integrations/zodomus');
    expect(status.body.data.health).toMatchObject({ connection: 'connected', credentials: 'valid' });
    expect(status.body.data.health.window.calls).toBe(2);
    expect(status.body.data.health.lastSuccessAt).toBeTruthy();
  });

  it('records call metadata only and audits the test', async () => {
    const calls = await superAdmin.get('/admin/integrations/zodomus/calls');
    expect(calls.body.data[0]).toMatchObject({ operation: 'account', httpMethod: 'GET', path: '/account', outcome: 'SUCCESS' });
    const rows = await withSystem(h.db, (tx) => tx.integrationCallLog.findMany({}));
    const audits = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { action: 'integration.connection_tested' } }));
    const everything = JSON.stringify(rows) + JSON.stringify(audits) + h.logLines.join('\n');
    expect(everything).not.toContain(API_PASS);
    expect(everything).not.toContain(API_USER);
    expect(everything).not.toContain(Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps call logs append-only for the application role', async () => {
    await expect(withSystem(h.db, (tx) => tx.integrationCallLog.updateMany({ data: { outcome: 'SUCCESS' } }))).rejects.toThrow(/permission denied/i);
  });
});

describe('reference data', () => {
  it('refreshes the channel list, sanitizes it and caches it', async () => {
    script['/channels'] = [{ status: 200, body: { channels: [{ id: 1, name: 'Booking.com', apiKey: 'should-not-be-stored' }, { id: 2, name: 'Expedia' }] } }];
    const res = await superAdmin.post('/admin/integrations/zodomus/reference/channels/refresh');
    expect(res.body.data).toMatchObject({ ok: true, stored: { itemCount: 2 } });
    const cached = await superAdmin.get('/admin/integrations/zodomus/reference/channels');
    expect(cached.body.data).toMatchObject({ kind: 'channels', itemCount: 2, payload: { channels: [{ id: 1, name: 'Booking.com' }, { id: 2 }] } });
    expect(JSON.stringify(cached.body)).not.toContain('should-not-be-stored');
  });

  it('stores the confirmed Zodomus channel shape as {id, name} without the status envelope', async () => {
    script['/channels'] = [{ status: 200, body: { status: { returnCode: 200, returnMessage: 'OK' }, channels: [{ id: 1, channel: 'Booking.com' }, { id: 2, channel: 'Expedia' }] } }];
    const res = await superAdmin.post('/admin/integrations/zodomus/reference/channels/refresh');
    expect(res.body.data).toMatchObject({ ok: true, providerCode: 200, providerMessage: 'OK', stored: { itemCount: 2 } });
    const cached = await superAdmin.get('/admin/integrations/zodomus/reference/channels');
    expect(cached.body.data.payload).toEqual([{ id: 1, name: 'Booking.com' }, { id: 2, name: 'Expedia' }]);
    const calls = await superAdmin.get('/admin/integrations/zodomus/calls');
    expect(calls.body.data[0]).toMatchObject({ providerCode: 200, providerMessage: 'OK' });
  });

  it('keeps the previous cache when a refresh fails', async () => {
    script['/channels'] = [{ status: 500 }, { status: 500 }, { status: 500 }];
    const res = await superAdmin.post('/admin/integrations/zodomus/reference/channels/refresh');
    expect(res.body.data).toMatchObject({ ok: false, outcome: 'SERVER_ERROR', attempts: 3, stored: null });
    const cached = await superAdmin.get('/admin/integrations/zodomus/reference/channels');
    expect(cached.body.data.itemCount).toBe(2);
  });

  it('keeps the cache when Zodomus reports an error inside HTTP 200', async () => {
    script['/channels'] = [{ status: 200, body: { status: { returnCode: 500, returnMessage: 'Internal error' } } }];
    const res = await superAdmin.post('/admin/integrations/zodomus/reference/channels/refresh');
    expect(res.body.data).toMatchObject({ ok: false, outcome: 'PROVIDER_ERROR', httpStatus: 200, providerCode: 500, stored: null });
    expect((await superAdmin.get('/admin/integrations/zodomus/reference/channels')).body.data.itemCount).toBe(2);
  });

  it('rejects unknown kinds and only ever called allowed read-only paths', async () => {
    expect((await superAdmin.post('/admin/integrations/zodomus/reference/rates/refresh')).status).toBe(404);
    expect(new Set(seenPaths)).toEqual(new Set(['/account', '/channels']));
  });
});

describe('access control', () => {
  it('lets support staff read status but not call Zodomus', async () => {
    expect((await support.get('/admin/integrations/zodomus')).status).toBe(200);
    expect((await support.post('/admin/integrations/zodomus/test')).status).toBe(403);
    expect((await support.post('/admin/integrations/zodomus/reference/channels/refresh')).status).toBe(403);
  });

  it('hides admin integration endpoints from owners', async () => {
    expect((await owner.get('/admin/integrations/zodomus')).status).toBe(403);
    expect((await owner.post('/admin/integrations/zodomus/test')).status).toBe(403);
  });
});

describe('owner channels view', () => {
  it('shows platform availability and channels without claiming any OTA connection', async () => {
    const res = await owner.get(`/organizations/${orgId}/channels`);
    expect(res.status).toBe(200);
    expect(res.body.data.provider).toMatchObject({ displayName: 'Zodomus', state: 'unavailable' }); // last call (refresh) failed
    expect(res.body.data.availableChannels.itemCount).toBe(2);
    expect(res.body.data.mapping).toMatchObject({ available: true, channelOptions: [expect.objectContaining({ channelId: 1, name: 'Booking.com' })] });
    expect(res.body.data.plan.channelsInUse).toBe(0);
    for (const p of res.body.data.properties as { connections: unknown[] }[]) expect(p.connections).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/errorMessage|httpStatus|credentials/);
  });

  it('returns 404 to non-members', async () => {
    const other = await h.createUser();
    const c = h.client();
    await c.login(other.email, other.password);
    expect((await c.get(`/organizations/${orgId}/channels`)).status).toBe(404);
  });
});
