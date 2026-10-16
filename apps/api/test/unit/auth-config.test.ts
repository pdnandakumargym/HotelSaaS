import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { cookieNames, setSessionCookies, type IssuedSession } from '../../src/modules/auth/session.service.js';
import { BASE_ENV } from '../helpers.js';

const PROD = { ...BASE_ENV, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com', APP_BASE_URL: 'https://app.example.com', MAIL_TRANSPORT: 'smtp', ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2' };

function issues(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues.join('\n');
    throw e;
  }
  return '';
}

describe('auth configuration', () => {
  it('requires a 32-byte DATA_ENCRYPTION_KEY', () => {
    expect(issues({ ...BASE_ENV, DATA_ENCRYPTION_KEY: undefined })).toMatch(/DATA_ENCRYPTION_KEY/);
    expect(issues({ ...BASE_ENV, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toMatch(/32 bytes/);
  });

  it('accepts a valid production configuration and makes cookies Secure', () => {
    const c = loadConfig(PROD);
    expect(c.auth.cookieSecure).toBe(true);
  });

  it.each([
    [{ APP_BASE_URL: 'http://app.example.com' }, /APP_BASE_URL/],
    [{ COOKIE_SECURE: 'false' }, /Secure/],
    [{ MAIL_TRANSPORT: 'log' }, /development only/],
    [{ ARGON2_MEMORY_KIB: '4096' }, /19456/],
  ])('rejects unsafe production setting %j', (override, msg) => {
    expect(issues({ ...PROD, ...override })).toMatch(msg);
  });

  it('rejects a lockout cap below the base duration', () => {
    expect(issues({ ...BASE_ENV, AUTH_LOCKOUT_BASE_SECONDS: '600', AUTH_LOCKOUT_MAX_SECONDS: '60' })).toMatch(/AUTH_LOCKOUT_MAX_SECONDS/);
  });
});

describe('session cookies in production', () => {
  it('uses the __Host- prefix with Secure, HttpOnly and SameSite', () => {
    const config = loadConfig(PROD);
    const set: { name: string; value: string; opts: Record<string, unknown> }[] = [];
    const res = { cookie: (name: string, value: string, opts: Record<string, unknown>) => set.push({ name, value, opts }) } as unknown as Response;
    const issued = { token: 't', csrfToken: 'c', session: { expiresAt: new Date(Date.now() + 3_600_000) } } as IssuedSession;
    setSessionCookies(res, config, issued);
    expect(cookieNames(true).session).toBe('__Host-ss_session');
    expect(set[0]).toMatchObject({ name: '__Host-ss_session', opts: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' } });
    expect(set[1]).toMatchObject({ name: 'ss_csrf', opts: { secure: true, httpOnly: false, sameSite: 'strict' } });
    expect(set[0]!.opts['domain']).toBeUndefined();
  });
});
