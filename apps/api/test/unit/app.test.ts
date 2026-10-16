import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { fakeHealth, memoryLogger, testConfig } from '../helpers.js';

function makeApp(
  overrides: Record<string, string> = {},
  health = fakeHealth('up'),
  rateLimitPerMinute?: number,
  registerRoutes?: Parameters<typeof createApp>[0]['registerRoutes'],
) {
  const { logger, lines } = memoryLogger();
  const app = createApp({ config: testConfig(overrides), logger, health, rateLimitPerMinute, registerRoutes });
  return { app, lines };
}

describe('health endpoints', () => {
  it('GET /api/v1/health returns liveness in the standard envelope', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', environment: 'test' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/health/ready returns 200 when the database is up', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health/ready').expect(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.checks.database.status).toBe('up');
  });

  it('GET /api/v1/health/ready returns 503 when the database is down', async () => {
    const { app } = makeApp({}, fakeHealth('down'));
    const res = await request(app).get('/api/v1/health/ready').expect(503);
    expect(res.body.data.status).toBe('not_ready');
  });
});

describe('request correlation', () => {
  it('generates a request id', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('propagates a well-formed incoming request id', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123_def.456');
    expect(res.headers['x-request-id']).toBe('abc-123_def.456');
  });
  it('replaces a malformed incoming request id (log-injection guard)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id" INJECT {}');
    expect(res.headers['x-request-id']).not.toContain('INJECT');
  });
});

describe('error envelope', () => {
  it('returns 404 JSON for unknown API routes', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });
  it('returns 404 JSON outside the API prefix', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/wp-admin').expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
  it('rejects malformed JSON with 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/health').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
  it('rejects bodies over BODY_LIMIT with 413', async () => {
    const { app } = makeApp({ BODY_LIMIT: '1kb' });
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('security headers', () => {
  it('sets strict headers and hides the framework', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
  it('sends HSTS in production', async () => {
    const { app } = makeApp({ NODE_ENV: 'production', APP_BASE_URL: 'https://app.example.com', MAIL_TRANSPORT: 'smtp', ARGON2_MEMORY_KIB: '19456', ARGON2_TIME_COST: '2', CORS_ORIGINS: 'https://app.example.com' });
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('CORS allowlist', () => {
  it('allows credentialed requests from an allowlisted origin', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:4200');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
  it('never reflects a non-allowlisted origin', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('never sends a wildcard origin', async () => {
    const { app } = makeApp();
    const res = await request(app).options('/api/v1/health').set('Origin', 'http://localhost:4200').set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
  });
  it('does not approve preflights from unknown origins', async () => {
    const { app } = makeApp();
    const res = await request(app).options('/api/v1/health').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'DELETE');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('blocks state-changing requests from unknown origins with 403', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/health').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });
  it('treats lookalike origins as different origins', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/health').set('Origin', 'http://localhost:4200.evil.example').send({});
    expect(res.status).toBe(403);
  });
});

describe('proxy / client IP handling', () => {
  // req.ip drives rate-limit keys and audit records; assert on it via a probe route.
  async function clientIp(trustProxy: string, xff?: string) {
    const { app } = makeApp({ TRUST_PROXY: trustProxy }, fakeHealth(), undefined, (api) => {
      api.get('/__ip', (req, res) => {
        res.json({ ip: req.ip });
      });
    });
    const r = request(app).get('/api/v1/__ip');
    if (xff) void r.set('X-Forwarded-For', xff);
    return (await r).body as { ip: string };
  }

  it('ignores X-Forwarded-For when no proxy is trusted (prevents IP spoofing)', async () => {
    const { ip } = await clientIp('false', '203.0.113.9');
    expect(ip).not.toBe('203.0.113.9');
  });
  it('uses the last hop when exactly one proxy is trusted', async () => {
    const { ip } = await clientIp('1', '198.51.100.1, 203.0.113.9');
    expect(ip).toBe('203.0.113.9');
  });
  it('trusts only listed proxy addresses', async () => {
    const { ip } = await clientIp('loopback', '198.51.100.1, 203.0.113.9');
    // supertest connects from loopback, so one hop is peeled off
    expect(ip).toBe('203.0.113.9');
  });
});

describe('rate limiting', () => {
  it('returns 429 in the standard envelope after the limit', async () => {
    const { app } = makeApp({}, fakeHealth(), 3);
    for (let i = 0; i < 3; i++) await request(app).get('/api/v1/health').expect(200);
    const res = await request(app).get('/api/v1/health').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('API docs', () => {
  it('serves the OpenAPI document when enabled', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths as Record<string, unknown>)).toEqual(expect.arrayContaining(['/api/v1/health', '/api/v1/health/ready']));
  });
  it('is not served when disabled', async () => {
    const { app } = makeApp({ API_DOCS_ENABLED: 'false' });
    await request(app).get('/api/openapi.json').expect(404);
    await request(app).get('/api/docs/').expect(404);
  });
});
