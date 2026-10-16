import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { fakeHealth, memoryLogger, testConfig } from '../helpers.js';

describe('log redaction', () => {
  it('redacts secrets in structured log fields at several depths', () => {
    const { logger, lines } = memoryLogger();
    logger.info(
      {
        password: 'hunter2',
        user: { password: 'p1', token: 't1' },
        zodomus: { request: { apiPassword: 'zp', authorization: 'Basic abc' } },
        headers: { authorization: 'Bearer xyz' },
      },
      'test',
    );
    const out = lines.join('\n');
    for (const secret of ['hunter2', 'p1', 't1', 'zp', 'Basic abc', 'Bearer xyz']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('never logs Authorization or Cookie request headers', async () => {
    const { logger, lines } = memoryLogger('info');
    const app = createApp({ config: testConfig({ LOG_LEVEL: 'info' }), logger, health: fakeHealth() });
    await request(app)
      .get('/api/v1/does-not-exist')
      .set('Authorization', 'Basic c2VjcmV0OnNlY3JldA==')
      .set('Cookie', 'sid=super-secret-session');
    const out = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(out).not.toContain('c2VjcmV0OnNlY3JldA==');
    expect(out).not.toContain('super-secret-session');
  });

  it('includes the request id in request logs', async () => {
    const { logger, lines } = memoryLogger('info');
    const app = createApp({ config: testConfig(), logger, health: fakeHealth() });
    const res = await request(app).get('/api/v1/unknown').set('X-Request-Id', 'corr-id-12345');
    expect(res.headers['x-request-id']).toBe('corr-id-12345');
    expect(lines.some((l) => l.includes('"id":"corr-id-12345"'))).toBe(true);
  });
});
