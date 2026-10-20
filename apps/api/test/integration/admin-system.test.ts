import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../src/modules/auth/totp.js';
import { Heartbeat } from '../../src/infrastructure/workers/heartbeat.js';
import { createHarness, type Harness } from './harness.js';
import { memoryLogger } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ZODOMUS_API_USERNAME: 'secret-user-sys', ZODOMUS_API_PASSWORD: 'secret-pass-sys' });
});
afterAll(async () => {
  await h.close();
});

async function admin(role: 'PLATFORM_SUPER_ADMIN' | 'PLATFORM_SUPPORT') {
  const a = await h.createUser({ platformRole: role });
  const c = h.client();
  await c.login(a.email, a.password);
  const setup = await c.post('/auth/2fa/setup');
  await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
  return c;
}

describe('admin system health', () => {
  it('reports database, migrations, workers, queue and configuration without secrets', async () => {
    const hb = new Heartbeat(h.db, 'worker', 'test', () => ({ sync: { runs: 1 } }), memoryLogger().logger);
    await hb.beat();
    try {
      const c = await admin('PLATFORM_SUPPORT');
      const res = await c.get('/admin/system');
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.database).toMatchObject({ ok: true, pendingMigrations: [] });
      expect(d.database.migrationsApplied).toBeGreaterThan(15);
      expect(d.workers.list.find((w: { id: string }) => w.id === hb.id)).toMatchObject({ role: 'worker', stale: false });
      expect(d.checks.find((x: { name: string }) => x.name === 'Background worker running').ok).toBe(true);
      expect(d.config.zodomus).toMatchObject({ credentialsConfigured: true });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('secret-user-sys');
      expect(text).not.toContain('secret-pass-sys');
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
    } finally {
      await hb.stop();
    }
  });

  it('is not available to customers', async () => {
    const u = await h.createUser();
    const c = h.client();
    await c.login(u.email, u.password);
    expect((await c.get('/admin/system')).status).toBe(403);
  });
});
