import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { totpAt } from '../../src/modules/auth/totp.js';
import { STRONG_PASSWORD, bodyWithoutRequestId, createHarness, tokenFrom, type Client, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const sys = <T>(fn: Parameters<typeof withSystem<T>>[1]) => withSystem(h.db, fn);
const STEP_MS = 30_000;

/** Enrolls TOTP for a signed-in client and returns the secret. Advances the clock past the used step. */
async function enroll(c: Client): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await c.post('/auth/2fa/setup');
  expect(setup.status).toBe(200);
  const secret = setup.body.data.secret as string;
  const enable = await c.post('/auth/2fa/enable', { code: totpAt(secret, Date.now() + h.clock.offsetMs) });
  expect(enable.status).toBe(200);
  h.clock.offsetMs += STEP_MS * 2;
  return { secret, recoveryCodes: enable.body.data.recoveryCodes as string[] };
}

const code = (secret: string) => totpAt(secret, Date.now() + h.clock.offsetMs);

describe('registration and email verification', () => {
  it('registers, requires verification, then signs in as organization owner', async () => {
    const c = h.client();
    const email = h.uniqueEmail('reg');
    const reg = await c.post('/auth/register', { email, password: STRONG_PASSWORD, displayName: 'Asha', organizationName: 'Asha Homestays' });
    expect(reg.status).toBe(202);

    const user = await sys((tx) => tx.user.findUniqueOrThrow({ where: { email } }));
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.emailVerifiedAt).toBeNull();

    const blocked = await c.login(email, STRONG_PASSWORD);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const mail = h.mailer.last(email);
    expect(mail?.subject).toMatch(/Verify/);
    const token = tokenFrom(mail?.text);
    expect((await c.post('/auth/verify-email', { token })).status).toBe(200);
    // single use
    const again = await c.post('/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');

    const login = await c.login(email, STRONG_PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.data.state).toBe('authenticated');
    expect(login.body.data.memberships).toHaveLength(1);
    expect(login.body.data.memberships[0]).toMatchObject({ organizationName: 'Asha Homestays', role: 'ORG_OWNER' });
  });

  it('does not reveal whether an email is already registered', async () => {
    const existing = await h.createUser();
    const c = h.client();
    const fresh = await c.post('/auth/register', { email: h.uniqueEmail('new'), password: STRONG_PASSWORD, displayName: 'N', organizationName: 'New Org' });
    const dup = await c.post('/auth/register', { email: existing.email.toUpperCase(), password: STRONG_PASSWORD, displayName: 'N', organizationName: 'Dup Org' });
    expect(dup.status).toBe(fresh.status);
    expect(bodyWithoutRequestId(dup)).toEqual(bodyWithoutRequestId(fresh));
    expect(h.mailer.last(existing.email)?.subject).toMatch(/Sign-up attempt/);
    expect(await sys((tx) => tx.user.count({ where: { email: existing.email } }))).toBe(1);
  });

  it('rejects weak passwords with helpful messages', async () => {
    const res = await h.client().post('/auth/register', { email: h.uniqueEmail(), password: 'short', displayName: 'N', organizationName: 'Org' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(res.body.error.details.problems[0]).toMatch(/12 characters/);
  });

  it('validates input', async () => {
    const res = await h.client().post('/auth/register', { email: 'not-an-email', password: STRONG_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('login', () => {
  it('returns the same generic error for unknown accounts and wrong passwords', async () => {
    const u = await h.createUser();
    const unknown = await h.client().login(h.uniqueEmail('nobody'), STRONG_PASSWORD);
    const wrong = await h.client().login(u.email, 'wrong password entirely');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(bodyWithoutRequestId(unknown)).toEqual(bodyWithoutRequestId(wrong));
  });

  it('sets a HttpOnly SameSite session cookie and a readable CSRF cookie', async () => {
    const u = await h.createUser();
    const res = await h.client().login(u.email, u.password);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('ss_session='))!;
    const csrf = cookies.find((c) => c.startsWith('ss_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Strict/i);
  });

  it('stores only hashes of session tokens', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const rows = await sys((tx) => tx.session.findMany({ where: { userId: u.id } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(c.sessionToken);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts emails case-insensitively', async () => {
    const u = await h.createUser();
    expect((await h.client().login(`  ${u.email.toUpperCase()} `, u.password)).status).toBe(200);
  });

  it('creates a new session on every login (no session fixation)', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const first = c.sessionToken;
    await c.login(u.email, u.password);
    expect(c.sessionToken).not.toBe(first);
    const active = await sys((tx) => tx.session.count({ where: { userId: u.id, revokedAt: null } }));
    expect(active).toBe(1);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without or with a wrong CSRF token', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const missing = await c.post('/auth/logout', {}, { csrf: null });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_TOKEN_INVALID');
    const wrong = await c.post('/auth/logout', {}, { csrf: 'x'.repeat(43) });
    expect(wrong.status).toBe(403);
    expect((await c.get('/auth/me')).body.data.state).toBe('authenticated');
  });

  it('accepts the matching token and logout revokes the session server-side', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const token = c.sessionToken!;
    expect((await c.post('/auth/logout')).status).toBe(200);
    // replaying the old cookie does not work
    c.setCookie('ss_session', token);
    expect((await c.get('/auth/me')).body.data.state).toBe('anonymous');
  });
});

describe('login attempt protection', () => {
  it('locks the account temporarily after repeated failures, even with the right password', async () => {
    const u = await h.createUser();
    const c = h.client();
    for (let i = 0; i < 5; i++) expect((await c.login(u.email, `wrong-${i}-password`)).status).toBe(401);
    const locked = await c.login(u.email, u.password);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS');

    const row = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id } }));
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(h.mailer.last(u.email)?.subject).toMatch(/Unusual sign-in activity/);
    const audit = await sys((tx) => tx.auditEvent.findFirst({ where: { action: 'auth.account.locked', entityId: u.id } }));
    expect(audit).not.toBeNull();
  });

  it('cannot be bypassed by changing IP address', async () => {
    const u = await h.createUser();
    for (let i = 0; i < 5; i++) {
      await h.client().post('/auth/login', { email: u.email, password: `wrong-${i}-password` }, { headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` } });
    }
    const res = await h.client().post('/auth/login', { email: u.email, password: u.password }, { headers: { 'X-Forwarded-For': '198.51.100.77' } });
    expect(res.status).toBe(401);
  });

  it('expires (no permanent lockout), backs off exponentially and resets after success', async () => {
    const u = await h.createUser();
    const c = h.client();
    for (let i = 0; i < 5; i++) await c.login(u.email, `wrong-${i}-password`);
    // lock expires
    await sys((tx) => tx.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }));
    await c.login(u.email, 'still-the-wrong-password');
    const second = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id } }));
    const duration = second.lockedUntil!.getTime() - Date.now();
    expect(duration).toBeGreaterThan(100_000); // 2 x 60 s
    expect(duration).toBeLessThanOrEqual(121_000);

    await sys((tx) => tx.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }));
    expect((await c.login(u.email, u.password)).status).toBe(200);
    const reset = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id } }));
    expect(reset.failedLoginCount).toBe(0);
    expect(reset.lockedUntil).toBeNull();
  });

  it('caps the lockout duration', async () => {
    const u = await h.createUser();
    await sys((tx) => tx.user.update({ where: { id: u.id }, data: { failedLoginCount: 30, lastFailedLoginAt: new Date() } }));
    await h.client().login(u.email, 'wrong-password-again');
    const row = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id } }));
    expect(row.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(900_000 + 1000);
  });
});

describe('password reset', () => {
  it('responds identically for unknown emails and sends nothing', async () => {
    const before = h.mailer.sent.length;
    const unknown = await h.client().post('/auth/password/forgot', { email: h.uniqueEmail('ghost') });
    const u = await h.createUser();
    const known = await h.client().post('/auth/password/forgot', { email: u.email });
    expect(unknown.status).toBe(202);
    expect(bodyWithoutRequestId(unknown)).toEqual(bodyWithoutRequestId(known));
    expect(h.mailer.sent.length).toBe(before + 1);
  });

  it('resets with a single-use token, signs out all sessions and clears lockouts', async () => {
    const u = await h.createUser();
    const signedIn = h.client();
    await signedIn.login(u.email, u.password);
    await sys((tx) => tx.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() + 60_000), failedLoginCount: 5 } }));

    await h.client().post('/auth/password/forgot', { email: u.email });
    const token = tokenFrom(h.mailer.last(u.email)?.text);
    const newPassword = 'a brand new long passphrase';
    expect((await h.client().post('/auth/password/reset', { token, password: newPassword })).status).toBe(200);

    expect((await signedIn.get('/auth/me')).body.data.state).toBe('anonymous');
    expect((await h.client().post('/auth/password/reset', { token, password: 'yet another passphrase' })).status).toBe(400);
    expect((await h.client().login(u.email, u.password)).status).toBe(401);
    expect((await h.client().login(u.email, newPassword)).status).toBe(200);
    expect(h.mailer.last(u.email)?.subject).toMatch(/password was changed/);
  });

  it('rejects expired tokens and tokens superseded by a newer request', async () => {
    const u = await h.createUser();
    await h.client().post('/auth/password/forgot', { email: u.email });
    const first = tokenFrom(h.mailer.last(u.email)?.text);
    await h.client().post('/auth/password/forgot', { email: u.email });
    const second = tokenFrom(h.mailer.last(u.email)?.text);
    expect((await h.client().post('/auth/password/reset', { token: first, password: 'another strong passphrase' })).status).toBe(400);
    await sys((tx) => tx.oneTimeToken.updateMany({ where: { userId: u.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect((await h.client().post('/auth/password/reset', { token: second, password: 'another strong passphrase' })).status).toBe(400);
  });

  it('requires a second factor when 2FA is enabled', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const { secret } = await enroll(c);
    await h.client().post('/auth/password/forgot', { email: u.email });
    const token = tokenFrom(h.mailer.last(u.email)?.text);
    const noCode = await h.client().post('/auth/password/reset', { token, password: 'reset with two factor ok' });
    expect(noCode.status).toBe(400);
    expect(noCode.body.error.code).toBe('MFA_CODE_REQUIRED');
    expect((await h.client().post('/auth/password/reset', { token, password: 'reset with two factor ok', code: code(secret) })).status).toBe(200);
  });
});

describe('two-factor authentication', () => {
  it('enrolls, then requires the second factor at sign-in', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const before = c.sessionToken;
    const { secret, recoveryCodes } = await enroll(c);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(c.sessionToken).not.toBe(before); // rotated on privilege change

    // secrets are not stored in plaintext
    const row = await sys((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id } }));
    expect(row.totpSecretEnc).toMatch(/^v1\./);
    expect(row.totpSecretEnc).not.toContain(secret);
    const codes = await sys((tx) => tx.recoveryCode.findMany({ where: { userId: u.id } }));
    expect(codes.map((x) => x.codeHash)).not.toContain(recoveryCodes[0]!.replace('-', ''));

    const c2 = h.client();
    const login = await c2.login(u.email, u.password);
    expect(login.body.data.state).toBe('mfa_pending');
    expect(login.body.data.memberships).toEqual([]);
    const blocked = await c2.get(`/organizations/${u.organizationId}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');

    expect((await c2.post('/auth/2fa/verify', { code: '000000' })).status).toBe(401);
    const pendingToken = c2.sessionToken;
    const ok = await c2.post('/auth/2fa/verify', { code: code(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.state).toBe('authenticated');
    expect(c2.sessionToken).not.toBe(pendingToken);
    expect((await c2.get(`/organizations/${u.organizationId}`)).status).toBe(200);
  });

  it('rejects replay of a code that was already used', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const { secret } = await enroll(c);
    const used = code(secret);
    const a = h.client();
    await a.login(u.email, u.password);
    expect((await a.post('/auth/2fa/verify', { code: used })).status).toBe(200);
    const b = h.client();
    await b.login(u.email, u.password);
    expect((await b.post('/auth/2fa/verify', { code: used })).status).toBe(401);
  });

  it('accepts each recovery code once and notifies the user', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const { recoveryCodes } = await enroll(c);
    const a = h.client();
    await a.login(u.email, u.password);
    expect((await a.post('/auth/2fa/verify', { recoveryCode: recoveryCodes[0]!.toLowerCase() })).status).toBe(200);
    expect(h.mailer.last(u.email)?.subject).toMatch(/recovery code was used/);
    const b = h.client();
    await b.login(u.email, u.password);
    expect((await b.post('/auth/2fa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(401);
  });

  it('revokes a pending session after too many wrong codes', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    await enroll(c);
    const a = h.client();
    await a.login(u.email, u.password);
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await a.post('/auth/2fa/verify', { code: '123456' }));
    const last = responses.at(-1)!;
    expect(last.status).toBe(401);
    expect(last.body.error.code).toBe('MFA_SESSION_REVOKED');
    expect((await a.get('/auth/me')).body.data.state).toBe('anonymous');
  });

  it('is mandatory for platform administrators', async () => {
    const admin = await h.createUser({ platformRole: 'PLATFORM_SUPER_ADMIN' });
    const c = h.client();
    const login = await c.login(admin.email, admin.password);
    expect(login.body.data.state).toBe('mfa_enrollment_required');
    const blocked = await c.get('/admin/overview');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    await enroll(c);
    expect((await c.get('/admin/overview')).status).toBe(200);

    const disable = await c.post('/auth/2fa/disable');
    expect(disable.status).toBe(403);
    expect(disable.body.error.code).toBe('MFA_MANDATORY');
  });

  it('can be required for all members by organization policy', async () => {
    const owner = await h.createUser();
    const staff = await h.createUser({ role: 'PROPERTY_STAFF', organizationId: owner.organizationId! });
    const oc = h.client();
    await oc.login(owner.email, owner.password);
    await enroll(oc); // the owner must not lock themselves out
    expect((await oc.send('patch', `/organizations/${owner.organizationId}/security`, { twoFactorRequired: true })).status).toBe(200);

    const sc = h.client();
    expect((await sc.login(staff.email, staff.password)).body.data.state).toBe('mfa_enrollment_required');
  });

  it('can be turned off where optional (with recent authentication)', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    await enroll(c);
    expect((await c.post('/auth/2fa/disable')).status).toBe(200);
    expect(h.mailer.last(u.email)?.subject).toMatch(/turned off/);
    expect((await h.client().login(u.email, u.password)).body.data.state).toBe('authenticated');
  });
});

describe('step-up authentication and password change', () => {
  async function makeStale(sessionUserId: string) {
    const old = new Date(Date.now() - 60 * 60_000);
    await sys((tx) => tx.session.updateMany({ where: { userId: sessionUserId, revokedAt: null }, data: { createdAt: old, stepUpAt: null, lastSeenAt: new Date() } }));
  }

  it('requires a recent password confirmation for sensitive changes', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const other = h.client();
    await other.login(u.email, u.password);
    await makeStale(u.id);

    const denied = await c.post('/auth/password/change', { newPassword: 'my new secure passphrase' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('STEP_UP_REQUIRED');

    expect((await c.post('/auth/step-up', { password: 'not my password' })).status).toBe(401);
    expect((await c.post('/auth/step-up', { password: u.password })).status).toBe(200);
    expect((await c.post('/auth/password/change', { newPassword: 'my new secure passphrase' })).status).toBe(200);

    expect((await c.get('/auth/me')).body.data.state).toBe('authenticated'); // current session kept
    expect((await other.get('/auth/me')).body.data.state).toBe('anonymous'); // others signed out
  });

  it('requires the 2FA code in step-up when 2FA is enabled', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    const { secret } = await enroll(c);
    await makeStale(u.id);
    const noCode = await c.post('/auth/step-up', { password: u.password });
    expect(noCode.body.error.code).toBe('MFA_CODE_REQUIRED');
    expect((await c.post('/auth/step-up', { password: u.password, code: code(secret) })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('lists my sessions and revokes the others', async () => {
    const u = await h.createUser();
    const a = h.client();
    const b = h.client();
    await a.login(u.email, u.password);
    await b.login(u.email, u.password);
    const list = await a.get('/auth/sessions');
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await a.post('/auth/sessions/revoke-others')).body.data.count).toBe(1);
    expect((await b.get('/auth/me')).body.data.state).toBe('anonymous');
  });

  it("cannot revoke another user's session", async () => {
    const u1 = await h.createUser();
    const u2 = await h.createUser();
    const a = h.client();
    await a.login(u1.email, u1.password);
    const b = h.client();
    await b.login(u2.email, u2.password);
    const target = (await b.get('/auth/sessions')).body.data[0].id as string;
    expect((await a.send('delete', `/auth/sessions/${target}`)).status).toBe(404);
    expect((await b.get('/auth/me')).body.data.state).toBe('authenticated');
  });

  it('expires idle sessions', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    await sys((tx) => tx.session.updateMany({ where: { userId: u.id }, data: { lastSeenAt: new Date(Date.now() - 13 * 3_600_000) } }));
    expect((await c.get('/auth/me')).body.data.state).toBe('anonymous');
  });

  it('rejects disabled users even with a valid session', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    await sys((tx) => tx.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } }));
    expect((await c.get('/auth/me')).body.data.state).toBe('anonymous');
  });
});

describe('audit and logs', () => {
  it('records successful and failed authentication events with request context', async () => {
    const u = await h.createUser();
    await h.client().login(u.email, 'wrong password here');
    await h.client().login(u.email, u.password);
    const events = await sys((tx) => tx.auditEvent.findMany({ where: { actorUserId: u.id }, orderBy: { createdAt: 'asc' } }));
    const actions = events.map((e) => e.action);
    expect(actions).toContain('auth.login.failed');
    expect(actions).toContain('auth.login.succeeded');
    expect(events.every((e) => e.requestId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(u.password);
  });

  it('never writes passwords, session tokens or codes to the logs', async () => {
    const u = await h.createUser({ password: 'unique-log-canary-passphrase' });
    const c = h.client();
    await c.login(u.email, 'unique-log-canary-passphrase');
    await c.post('/auth/2fa/setup');
    const out = h.logLines.join('\n');
    expect(out).not.toContain('unique-log-canary-passphrase');
    expect(out).not.toContain(c.sessionToken!);
    expect(out).not.toContain(c.csrf!);
  });
});
