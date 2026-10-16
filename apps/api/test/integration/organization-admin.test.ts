import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { totpAt } from '../../src/modules/auth/totp.js';
import { STRONG_PASSWORD, bodyWithoutRequestId, createHarness, tokenFrom, type Client, type Harness } from './harness.js';

let h: Harness;
let owner: Client;
let ownerUser: { id: string; email: string; password: string; organizationId: string | null };
let orgId: string;
// Unique per run (UUIDv7 prefixes are time-based and repeat across quick reruns).
const RUN = Math.random().toString(36).slice(2, 10);

async function adminClient(role: 'PLATFORM_SUPER_ADMIN' | 'PLATFORM_SUPPORT' = 'PLATFORM_SUPER_ADMIN') {
  const a = await h.createUser({ platformRole: role });
  const c = h.client();
  await c.login(a.email, a.password);
  const setup = await c.post('/auth/2fa/setup');
  await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
  return { c, user: a };
}

beforeAll(async () => {
  h = await createHarness();
  ownerUser = await h.createUser();
  orgId = ownerUser.organizationId!;
  owner = h.client();
  await owner.login(ownerUser.email, ownerUser.password);
});
afterAll(async () => {
  await h.close();
});

describe('organization settings', () => {
  it('lets the owner rename the organization and change currency', async () => {
    const res = await owner.send('patch', `/organizations/${orgId}`, { name: 'Renamed Stays', defaultCurrency: 'usd' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed Stays', defaultCurrency: 'USD' });
  });

  it('shows plan, usage and limits', async () => {
    const res = await owner.get(`/organizations/${orgId}/subscription`);
    expect(res.body.data).toMatchObject({ status: 'TRIALING', plan: { code: 'FREE', maxProperties: 1, maxUsers: 2 }, usage: { members: 1, properties: 0 } });
    expect((await owner.get('/plans')).body.data.map((p: { code: string }) => p.code)).toEqual(['FREE', 'PRO', 'PREMIUM']);
  });
});

describe('invitations and members', () => {
  let inviteToken: string;
  const invitee = () => `invitee-${RUN}@example.test`;

  it('invites by email and sends a link with the token in the fragment', async () => {
    const res = await owner.post(`/organizations/${orgId}/invitations`, { email: invitee().toUpperCase(), role: 'PROPERTY_MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: invitee(), role: 'PROPERTY_MANAGER' });
    const mail = h.mailer.last(invitee());
    expect(mail?.text).toMatch(/\/invite#token=/);
    inviteToken = tokenFrom(mail?.text);
    const row = await withSystem(h.db, (tx) => tx.invitation.findFirstOrThrow({ where: { email: invitee() } }));
    expect(row.tokenHash).not.toBe(inviteToken);
  });

  it('counts pending invitations against the plan user limit', async () => {
    // Free plan: 2 users = owner + 1 pending invitation
    const res = await owner.post(`/organizations/${orgId}/invitations`, { email: `third-${RUN}@example.test`, role: 'READ_ONLY' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('previews the invitation for the token holder', async () => {
    const res = await h.client().post('/invitations/preview', { token: inviteToken });
    expect(res.body.data).toMatchObject({ organizationName: 'Renamed Stays', email: invitee(), role: 'PROPERTY_MANAGER', accountExists: false });
  });

  it('lets the invitee create an account and join (email counts as verified)', async () => {
    const c = h.client();
    const res = await c.post('/invitations/register', { token: inviteToken, displayName: 'Manny Manager', password: STRONG_PASSWORD });
    expect(res.status).toBe(201);
    const me = await c.get('/auth/me');
    expect(me.body.data.state).toBe('authenticated');
    expect(me.body.data.memberships[0]).toMatchObject({ organizationId: orgId, role: 'PROPERTY_MANAGER' });
    // single use
    expect((await h.client().post('/invitations/preview', { token: inviteToken })).status).toBe(400);
  });

  it('only accepts for the invited email when signed in', async () => {
    const stranger = await h.createUser();
    const sc = h.client();
    await sc.login(stranger.email, stranger.password);
    await withSystem(h.db, async (tx) => {
      const pro = await tx.plan.findUniqueOrThrow({ where: { code: 'PRO' } });
      await tx.subscription.update({ where: { organizationId: orgId }, data: { planId: pro.id, status: 'ACTIVE' } });
    });
    await owner.post(`/organizations/${orgId}/invitations`, { email: `someone-else-${RUN}@example.test`, role: 'READ_ONLY' });
    const token = tokenFrom(h.mailer.last(`someone-else-${RUN}@example.test`)?.text);
    const res = await sc.post('/invitations/accept', { token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('lets an existing user accept with their own email', async () => {
    const existing = await h.createUser();
    await owner.post(`/organizations/${orgId}/invitations`, { email: existing.email, role: 'PROPERTY_STAFF' });
    const token = tokenFrom(h.mailer.last(existing.email)?.text);
    expect((await h.client().post('/invitations/preview', { token })).body.data.accountExists).toBe(true);
    const c = h.client();
    await c.login(existing.email, existing.password);
    expect((await c.post('/invitations/accept', { token })).status).toBe(200);
    const orgs = await c.get('/organizations');
    expect(orgs.body.data.map((o: { id: string }) => o.id)).toContain(orgId);
  });

  it('refuses to invite an existing member', async () => {
    const res = await owner.post(`/organizations/${orgId}/invitations`, { email: ownerUser.email, role: 'READ_ONLY' });
    expect(res.status).toBe(409);
  });

  it('revokes and resends invitations; a new invite replaces the old link', async () => {
    const email = `revoke-${RUN}@example.test`;
    const inv = await owner.post(`/organizations/${orgId}/invitations`, { email, role: 'READ_ONLY' });
    const first = tokenFrom(h.mailer.last(email)?.text);
    expect((await owner.post(`/organizations/${orgId}/invitations/${inv.body.data.id}/resend`)).status).toBe(200);
    const second = tokenFrom(h.mailer.last(email)?.text);
    expect((await h.client().post('/invitations/preview', { token: first })).status).toBe(400);
    expect((await h.client().post('/invitations/preview', { token: second })).status).toBe(200);
    expect((await owner.send('delete', `/organizations/${orgId}/invitations/${inv.body.data.id}`)).status).toBe(200);
    expect((await h.client().post('/invitations/preview', { token: second })).status).toBe(400);
  });

  it('protects the last owner and lets owners change roles', async () => {
    const members = (await owner.get(`/organizations/${orgId}/members`)).body.data as { membershipId: string; role: string; isMe: boolean }[];
    const me = members.find((m) => m.isMe)!;
    const demote = await owner.send('patch', `/organizations/${orgId}/members/${me.membershipId}`, { role: 'READ_ONLY' });
    expect(demote.body.error.code).toBe('LAST_OWNER');
    expect((await owner.send('delete', `/organizations/${orgId}/members/${me.membershipId}`)).body.error.code).toBe('LAST_OWNER');
    const manager = members.find((m) => m.role === 'PROPERTY_MANAGER')!;
    expect((await owner.send('patch', `/organizations/${orgId}/members/${manager.membershipId}`, { role: 'READ_ONLY' })).status).toBe(200);
  });

  it('does not let non-owners manage members or invitations', async () => {
    const staff = await h.createUser({ role: 'PROPERTY_MANAGER', organizationId: orgId });
    const c = h.client();
    await c.login(staff.email, staff.password);
    expect((await c.get(`/organizations/${orgId}/invitations`)).status).toBe(403);
    expect((await c.post(`/organizations/${orgId}/invitations`, { email: 'x@example.test', role: 'ORG_OWNER' })).status).toBe(403);
    const members = (await c.get(`/organizations/${orgId}/members`)).body.data as { membershipId: string; isMe: boolean; role: string }[];
    const ownerRow = members.find((m) => m.role === 'ORG_OWNER')!;
    expect((await c.send('delete', `/organizations/${orgId}/members/${ownerRow.membershipId}`)).status).toBe(403);
    // but anyone may leave
    const mine = members.find((m) => m.isMe)!;
    expect((await c.send('delete', `/organizations/${orgId}/members/${mine.membershipId}`)).status).toBe(200);
    expect((await c.get(`/organizations/${orgId}`)).status).toBe(404);
  });
});

describe('platform administration', () => {
  it('shows organization detail without tenant guest data', async () => {
    const { c } = await adminClient();
    const res = await c.get(`/admin/organizations/${orgId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: orgId, subscription: { plan: { code: expect.any(String) } } });
    expect(Array.isArray(res.body.data.members)).toBe(true);
  });

  it('suspends an organization: members are blocked until reactivated (recent auth required)', async () => {
    const { c } = await adminClient();
    expect((await c.send('patch', `/admin/organizations/${orgId}/status`, { status: 'SUSPENDED', reason: 'Payment dispute' })).status).toBe(200);
    const blocked = await owner.get(`/organizations/${orgId}/properties`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ORG_SUSPENDED');
    expect((await owner.get('/auth/me')).body.data.memberships[0].organizationStatus).toBe('SUSPENDED');
    expect((await c.send('patch', `/admin/organizations/${orgId}/status`, { status: 'ACTIVE', reason: 'Resolved dispute' })).status).toBe(200);
    expect((await owner.get(`/organizations/${orgId}/properties`)).status).toBe(200);
    const events = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, action: { startsWith: 'admin.org.' } } }));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['admin.org.suspended', 'admin.org.reactivated']));
  });

  it('changes the plan and the new limits apply', async () => {
    const { c } = await adminClient();
    const res = await c.send('patch', `/admin/organizations/${orgId}/subscription`, { planCode: 'premium' });
    expect(res.body.data).toEqual({ planCode: 'PREMIUM', status: 'ACTIVE' });
    expect((await owner.get(`/organizations/${orgId}/subscription`)).body.data.plan.code).toBe('PREMIUM');
    expect((await c.send('patch', `/admin/organizations/${orgId}/subscription`, { planCode: 'NOPE' })).status).toBe(400);
  });

  it('limits support staff: no suspension, no plan changes', async () => {
    const { c } = await adminClient('PLATFORM_SUPPORT');
    expect((await c.get(`/admin/organizations/${orgId}`)).status).toBe(200);
    expect((await c.send('patch', `/admin/organizations/${orgId}/status`, { status: 'SUSPENDED', reason: 'testing it' })).status).toBe(403);
    expect((await c.send('patch', `/admin/organizations/${orgId}/subscription`, { planCode: 'FREE' })).status).toBe(403);
  });

  it('lists properties across tenants', async () => {
    const { c } = await adminClient();
    expect((await c.get('/admin/properties')).status).toBe(200);
  });
});

describe('support access (owner-approved, time-boxed, audited)', () => {
  it('requires owner approval before any tenant data is visible', async () => {
    await withSystem(h.db, (tx) =>
      tx.property.create({ data: { organizationId: orgId, name: 'Support Visible Villa', propertyType: 'VILLA', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' } }),
    );
    const { c } = await adminClient('PLATFORM_SUPPORT');
    const req = await c.post('/admin/support-access', { organizationId: orgId, reason: 'Customer reported a missing room type', durationMinutes: 60 });
    expect(req.status).toBe(201);
    const requestId = req.body.data.id as string;
    expect(h.mailer.last(ownerUser.email)?.subject).toMatch(/temporary access/);

    // pending -> no access
    expect((await c.get(`/admin/support-access/${requestId}/properties`)).status).toBe(403);

    // owner sees and approves
    const list = await owner.get(`/organizations/${orgId}/support-access`);
    expect(list.body.data[0]).toMatchObject({ id: requestId, status: 'PENDING' });
    expect((await owner.post(`/organizations/${orgId}/support-access/${requestId}/approve`)).status).toBe(200);

    const data = await c.get(`/admin/support-access/${requestId}/properties`);
    expect(data.status).toBe(200);
    expect(data.body.data.map((p: { name: string }) => p.name)).toContain('Support Visible Villa');
    expect(data.body.meta.accessExpiresAt).toBeTruthy();

    const audit = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, action: { startsWith: 'support.' } } }));
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['support.access.requested', 'support.access.approved', 'support.data_accessed']));

    // owner revokes -> access ends immediately
    expect((await owner.post(`/organizations/${orgId}/support-access/${requestId}/revoke`)).status).toBe(200);
    expect((await c.get(`/admin/support-access/${requestId}/properties`)).status).toBe(403);
  });

  it('expires automatically and cannot be used by another admin', async () => {
    const { c } = await adminClient('PLATFORM_SUPPORT');
    const { c: other } = await adminClient('PLATFORM_SUPPORT');
    const req = await c.post('/admin/support-access', { organizationId: orgId, reason: 'Checking sync configuration', durationMinutes: 15 });
    const requestId = req.body.data.id as string;
    await owner.post(`/organizations/${orgId}/support-access/${requestId}/approve`);
    expect((await other.get(`/admin/support-access/${requestId}/properties`)).status).toBe(403);
    await withSystem(h.db, (tx) => tx.supportAccessRequest.update({ where: { id: requestId }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect((await c.get(`/admin/support-access/${requestId}/properties`)).status).toBe(403);
  });

  it('can be denied and validates the request', async () => {
    const { c } = await adminClient('PLATFORM_SUPPORT');
    expect((await c.post('/admin/support-access', { organizationId: orgId, reason: 'short', durationMinutes: 60 })).status).toBe(400);
    expect((await c.post('/admin/support-access', { organizationId: orgId, reason: 'A long enough reason here', durationMinutes: 999 })).status).toBe(400);
    const req = await c.post('/admin/support-access', { organizationId: orgId, reason: 'A long enough reason here', durationMinutes: 30 });
    expect((await owner.post(`/organizations/${orgId}/support-access/${req.body.data.id}/deny`)).body.data.status).toBe('DENIED');
    expect((await c.get(`/admin/support-access/${req.body.data.id}/properties`)).status).toBe(403);
  });

  it('is not available to organization owners on the admin side', async () => {
    expect((await owner.post('/admin/support-access', { organizationId: orgId, reason: 'Trying to escalate', durationMinutes: 30 })).status).toBe(403);
  });
});

describe('email change', () => {
  it('confirms via the new address, notifies the old one and signs out everywhere', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const newEmail = `moved-${RUN}@example.test`;
    expect((await c.post('/auth/email/change', { email: newEmail })).status).toBe(202);
    expect(h.mailer.last(u.email)?.subject).toMatch(/Email change requested/);
    const token = tokenFrom(h.mailer.last(newEmail)?.text);
    expect((await h.client().post('/auth/email/confirm', { token })).status).toBe(200);
    expect((await c.get('/auth/me')).body.data.state).toBe('anonymous');
    expect((await h.client().login(newEmail, u.password)).status).toBe(200);
    expect((await h.client().login(u.email, u.password)).status).toBe(401);
    expect(h.mailer.last(u.email)?.subject).toMatch(/was changed/);
  });

  it('does not reveal whether the new address is taken', async () => {
    const u = await h.createUser();
    const taken = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const free = await c.post('/auth/email/change', { email: `free-${RUN}@example.test` });
    const used = await c.post('/auth/email/change', { email: taken.email });
    expect(used.status).toBe(free.status);
    expect(bodyWithoutRequestId(used)).toEqual(bodyWithoutRequestId(free));
    expect(h.mailer.last(taken.email)?.subject).toMatch(/Email change attempt/);
  });
});
