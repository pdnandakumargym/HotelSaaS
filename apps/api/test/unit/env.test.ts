import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { BASE_ENV } from '../helpers.js';

function load(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = load();
    expect(c.port).toBe(3000);
    expect(c.host).toBe('127.0.0.1');
    expect(c.trustProxy).toBe(false);
    expect(c.bodyLimit).toBe('100kb');
    expect(c.apiDocsEnabled).toBe(true);
    expect(c.zodomus.enabled).toBe(false);
    expect(c.zodomus.environment).toBe('sandbox');
    expect(c.zodomus.baseUrl).toBe('https://api.zodomus.com');
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('requires DATABASE_URL and a postgres scheme', () => {
    expect(issuesOf(() => load({ DATABASE_URL: undefined })).join()).toMatch(/DATABASE_URL/);
    expect(issuesOf(() => load({ DATABASE_URL: 'mysql://x' })).join()).toMatch(/postgresql/);
  });

  it('treats empty strings as unset', () => {
    expect(load({ PORT: '' }).port).toBe(3000);
  });

  describe('CORS_ORIGINS', () => {
    it('parses a comma list of origins', () => {
      expect(load({ CORS_ORIGINS: 'http://localhost:4200, https://a.example.com' }).corsOrigins).toEqual([
        'http://localhost:4200',
        'https://a.example.com',
      ]);
    });
    it.each(['*', 'https://*.example.com'])('rejects wildcard %s', (v) => {
      expect(issuesOf(() => load({ CORS_ORIGINS: v })).join()).toMatch(/wildcard/);
    });
    it('rejects origins with paths', () => {
      expect(issuesOf(() => load({ CORS_ORIGINS: 'https://a.example.com/app' })).join()).toMatch(/no path/);
    });
    it('requires https origins in production', () => {
      const issues = issuesOf(() => load({ NODE_ENV: 'production', CORS_ORIGINS: 'http://app.example.com' }));
      expect(issues.join()).toMatch(/https/);
    });
    it('requires at least one origin in production', () => {
      expect(issuesOf(() => load({ NODE_ENV: 'production', CORS_ORIGINS: '' })).join()).toMatch(/must be set/);
    });
  });

  describe('TRUST_PROXY', () => {
    it.each([
      ['false', false],
      ['0', false],
      ['1', 1],
      ['2', 2],
      ['loopback', ['loopback']],
      ['10.0.0.0/8, 192.168.1.10', ['10.0.0.0/8', '192.168.1.10']],
    ])('parses %s', (input, expected) => {
      expect(load({ TRUST_PROXY: input }).trustProxy).toEqual(expected);
    });
    it.each(['true', '*'])('refuses to trust every proxy (%s)', (v) => {
      expect(issuesOf(() => load({ TRUST_PROXY: v })).join()).toMatch(/spoofing/);
    });
    it('rejects junk entries', () => {
      expect(issuesOf(() => load({ TRUST_PROXY: 'my-proxy.local' })).join()).toMatch(/not an IP/);
    });
  });

  describe('Zodomus', () => {
    it('requires credentials when enabled, without echoing values', () => {
      const issues = issuesOf(() => load({ ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: 'someone' }));
      expect(issues.join()).toMatch(/ZODOMUS_API_PASSWORD/);
      expect(issues.join()).not.toMatch(/someone/);
    });
    it('reports credentialsConfigured', () => {
      const c = load({ ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: 'u', ZODOMUS_API_PASSWORD: 'p' });
      expect(c.zodomus.credentialsConfigured).toBe(true);
    });
    it('blocks sandbox config in production', () => {
      const issues = issuesOf(() =>
        load({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.example.com',
          ZODOMUS_ENABLED: 'true',
          ZODOMUS_API_USERNAME: 'u',
          ZODOMUS_API_PASSWORD: 'p',
          ZODOMUS_ENVIRONMENT: 'sandbox',
        }),
      );
      expect(issues.join()).toMatch(/sandbox Zodomus configuration is not allowed/);
    });
    it('blocks production Zodomus access outside production', () => {
      expect(issuesOf(() => load({ ZODOMUS_ENVIRONMENT: 'production' })).join()).toMatch(/only allowed when NODE_ENV=production/);
    });
    it('requires https base URL', () => {
      expect(issuesOf(() => load({ ZODOMUS_BASE_URL: 'http://api.zodomus.com' })).join()).toMatch(/https/);
    });
  });

  it('disables API docs by default in production', () => {
    expect(load({ NODE_ENV: 'production', APP_BASE_URL: 'https://app.example.com', MAIL_TRANSPORT: 'smtp', ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2', CORS_ORIGINS: 'https://app.example.com' }).apiDocsEnabled).toBe(false);
  });
});
