import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CallRecord } from '../../src/modules/channels/channel-provider.js';
import { countItems, describeShape, sanitizePayload } from '../../src/modules/channels/sanitize.js';
import { ZodomusAdapter } from '../../src/modules/channels/zodomus/zodomus.adapter.js';
import { ZodomusClient, type FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { memoryLogger, testConfig } from '../helpers.js';

const USER = 'test-api-user-123';
const PASS = 'test-api-pass-456';

function setup(fetchImpl: FetchLike, extra: { maxRetries?: number; maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const { logger, lines } = memoryLogger('debug');
  const records: CallRecord[] = [];
  const client = new ZodomusClient({
    baseUrl: 'https://api.zodomus.example',
    username: USER,
    password: PASS,
    environment: 'sandbox',
    timeoutMs: extra.timeoutMs ?? 2000,
    logger,
    recorder: { record: (e) => Promise.resolve(void records.push(e)) },
    fetch: fetchImpl,
    backoffMs: 0,
    maxRetries: extra.maxRetries,
    maxResponseBytes: extra.maxResponseBytes,
  });
  return { client, lines, records };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('ZodomusClient', () => {
  it('sends HTTP Basic auth over HTTPS to an allowed read-only path and parses JSON', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const { client, records } = setup((url, init) => {
      seen.push({ url, init });
      return Promise.resolve(json({ channels: [{ id: 1, name: 'Booking.com' }] }));
    });
    const r = await client.get('channels', { requestId: 'req-1' });
    expect(r).toMatchObject({ ok: true, outcome: 'SUCCESS', httpStatus: 200, attempts: 1, data: { channels: [{ id: 1 }] } });
    expect(seen[0]!.url).toBe('https://api.zodomus.example/channels');
    expect(seen[0]!.init.method).toBe('GET');
    const auth = (seen[0]!.init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`);
    expect(records[0]).toMatchObject({ provider: 'zodomus', operation: 'channels', path: '/channels', httpMethod: 'GET', outcome: 'SUCCESS', requestId: 'req-1' });
  });

  it('never logs or records credentials, auth headers or response bodies', async () => {
    const { client, lines, records } = setup(() => Promise.resolve(json({ secretValue: 'body-content-xyz' })));
    await client.get('account');
    const all = JSON.stringify(lines) + JSON.stringify(records);
    for (const needle of [USER, PASS, Buffer.from(`${USER}:${PASS}`).toString('base64'), 'body-content-xyz']) expect(all).not.toContain(needle);
    expect(inspect(client)).not.toContain(PASS);
    expect(JSON.stringify(client)).not.toContain(PASS);
  });

  it('maps 401 to AUTH_ERROR without retrying', async () => {
    let calls = 0;
    const { client } = setup(() => {
      calls++;
      return Promise.resolve(json({ error: 'nope' }, 401));
    });
    const r = await client.get('account');
    expect(r).toMatchObject({ ok: false, outcome: 'AUTH_ERROR', httpStatus: 401, attempts: 1 });
    expect(r.error!.message).toContain('credentials');
    expect(calls).toBe(1);
  });

  it('retries 503 and 429, then succeeds', async () => {
    const statuses = [503, 429, 200];
    const { client } = setup(() => {
      const s = statuses.shift()!;
      return Promise.resolve(s === 200 ? json([1, 2]) : json({}, s));
    });
    const r = await client.get('currencies');
    expect(r).toMatchObject({ ok: true, attempts: 3, data: [1, 2] });
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    const { client, records } = setup(() => {
      calls++;
      return Promise.resolve(json({}, 502));
    }, { maxRetries: 2 });
    const r = await client.get('priceModels');
    expect(r).toMatchObject({ ok: false, outcome: 'SERVER_ERROR', attempts: 3 });
    expect(calls).toBe(3);
    expect(records).toHaveLength(1);
  });

  it('reports timeouts and network errors', async () => {
    const slow = setup((_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))), { timeoutMs: 1000, maxRetries: 0 });
    expect((await slow.client.get('account')).outcome).toBe('TIMEOUT');
    const down = setup(() => Promise.reject(new TypeError('fetch failed')), { maxRetries: 0 });
    expect((await down.client.get('account')).outcome).toBe('NETWORK_ERROR');
  });

  it('rejects invalid JSON and oversized responses', async () => {
    const bad = setup(() => Promise.resolve(new Response('<html>oops</html>', { status: 200 })));
    expect((await bad.client.get('account')).outcome).toBe('INVALID_RESPONSE');
    const big = setup(() => Promise.resolve(new Response('x'.repeat(5000), { status: 200 })), { maxResponseBytes: 1000 });
    const r = await big.client.get('account');
    expect(r).toMatchObject({ outcome: 'INVALID_RESPONSE', error: { code: 'RESPONSE_TOO_LARGE' } });
  });

  it('only allows the four documented read-only operations and refuses plain http', async () => {
    const { client } = setup(() => Promise.resolve(json({})));
    // @ts-expect-error not an allowed operation
    await expect(client.get('rates')).rejects.toThrow(/not allowed/);
    expect(() => new ZodomusClient({ baseUrl: 'http://api.zodomus.com', username: 'u', password: 'p', environment: 'sandbox', timeoutMs: 1000, logger: memoryLogger().logger })).toThrow(/https/);
  });
});

describe('ZodomusAdapter', () => {
  it('is not ready (and makes no calls) when disabled or credentials are missing', () => {
    const disabled = new ZodomusAdapter(testConfig().zodomus, memoryLogger().logger);
    expect(disabled.isReady()).toBe(false);
    expect(disabled.configStatus()).toMatchObject({ provider: 'zodomus', enabled: false, credentialsConfigured: false });
    expect(() => disabled.testConnection({})).toThrow(/not enabled/);
  });

  it('exposes configuration status without credential values', () => {
    const cfg = testConfig({ ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: USER, ZODOMUS_API_PASSWORD: PASS }).zodomus;
    const a = new ZodomusAdapter(cfg, memoryLogger().logger, undefined, () => Promise.resolve(json({})));
    expect(a.isReady()).toBe(true);
    const s = JSON.stringify(a.configStatus());
    expect(s).not.toContain(USER);
    expect(s).not.toContain(PASS);
  });
});

describe('sanitizePayload', () => {
  it('drops credential and card-like keys at any depth and keeps normal data', () => {
    const out = sanitizePayload({
      name: 'Acme',
      currency: 'EUR',
      ccy: 'EUR',
      apiKey: 'k',
      api_user: 'u',
      nested: { password: 'p', token: 't', cardNumber: '4111', cc_cvv: '1', ok: [{ username: 'x', id: 7 }] },
    });
    expect(out).toEqual({ name: 'Acme', currency: 'EUR', ccy: 'EUR', nested: { ok: [{ id: 7 }] } });
  });

  it('bounds depth, array length and string length', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(sanitizePayload(deep))).toContain('[truncated]');
    expect((sanitizePayload(Array.from({ length: 5000 }, (_, i) => i)) as unknown[]).length).toBe(1000);
    expect((sanitizePayload('a'.repeat(5000)) as string).length).toBeLessThan(2100);
  });

  it('counts items and describes shape without values', () => {
    expect(countItems([1, 2, 3])).toBe(3);
    expect(countItems({ status: 'ok', channels: [1, 2] })).toBe(2);
    expect(countItems({ a: 1 })).toBeNull();
    const shape = JSON.stringify(describeShape({ name: 'Secret Hotel', id: 5, apiPassword: 'zzz', list: [{ code: 'EUR' }] }));
    expect(shape).not.toMatch(/Secret Hotel|zzz|EUR/);
    expect(shape).toContain('"name":"string"');
  });
});

describe('Zodomus response shapes (confirmed with the sandbox probe)', () => {
  const status = { returnCode: 200, returnMessage: 'OK', channelLogId: 'x', channelOtherMessages: '', timestamp: '2026-10-16 10:00:00' };

  it('captures the status envelope on success and on HTTP errors', async () => {
    const ok = setup(() => Promise.resolve(json({ status, channels: [] })));
    expect(await ok.client.get('channels')).toMatchObject({ providerCode: 200, providerMessage: 'OK' });
    expect(ok.records[0]).toMatchObject({ providerCode: 200, providerMessage: 'OK' });
    const bad = setup(() => Promise.resolve(json({ status: { returnCode: 401, returnMessage: 'Invalid credentials' } }, 401)));
    expect(await bad.client.get('account')).toMatchObject({ outcome: 'AUTH_ERROR', providerCode: 401, providerMessage: 'Invalid credentials' });
  });

  it('normalizes channels, currencies and price models', async () => {
    const { normalizeReference } = await import('../../src/modules/channels/zodomus/zodomus.mappers.js');
    expect(normalizeReference('channels', { status, channels: [{ id: 1, channel: 'Booking.com' }, { id: 2, channel: 'Expedia' }] })).toEqual([
      { id: 1, name: 'Booking.com' },
      { id: 2, name: 'Expedia' },
    ]);
    expect(normalizeReference('currencies', { status, currencies: [{ code: 'eur', name: 'Euro' }] })).toEqual([{ code: 'EUR', name: 'Euro' }]);
    expect(normalizeReference('price_models', { status, models: [{ id: 3, model: 'Per occupancy' }] })).toEqual([{ id: 3, name: 'Per occupancy' }]);
    expect(normalizeReference('channels', { channels: [{ id: 1, name: 'unexpected shape' }] })).toBeNull();
  });

  it('keeps only non-sensitive account fields (no contact details, no webhook key)', async () => {
    const { normalizeReference } = await import('../../src/modules/channels/zodomus/zodomus.mappers.js');
    const account = {
      name: 'Acme Channel Co',
      address: '1 Street',
      postalcode: '1000',
      city: 'Lisbon',
      country: 'PT',
      email: 'ops@acme.example',
      phone: '+351 000',
      webhook: 'https://hooks.example/zodomus',
      webhook_key: 'whk_secret_value',
      api_status: 'test',
    };
    const out = normalizeReference('account', { status, account });
    expect(out).toEqual({ name: 'Acme Channel Co', city: 'Lisbon', country: 'PT', apiStatus: 'test', webhookConfigured: true });
    expect(JSON.stringify(sanitizePayload({ account }))).not.toContain('whk_secret_value');
  });
});

describe('Zodomus errors reported inside HTTP 200', () => {
  it('treats returnCode other than 200 as PROVIDER_ERROR, without retrying or returning data', async () => {
    let calls = 0;
    const { client, records } = setup(() => {
      calls++;
      return Promise.resolve(json({ status: { returnCode: 400, returnMessage: 'Property not found' }, channels: [{ id: 1, channel: 'X' }] }));
    });
    const r = await client.get('channels');
    expect(r).toMatchObject({ ok: false, outcome: 'PROVIDER_ERROR', httpStatus: 200, providerCode: 400, providerMessage: 'Property not found', attempts: 1 });
    expect(r.data).toBeUndefined();
    expect(r.error!.message).toContain('code 400');
    expect(calls).toBe(1);
    expect(records[0]).toMatchObject({ outcome: 'PROVIDER_ERROR', providerCode: 400 });
  });

  it('accepts returnCode 200 and replies without a status envelope', async () => {
    const a = setup(() => Promise.resolve(json({ status: { returnCode: 200, returnMessage: 'OK' }, models: [] })));
    expect((await a.client.get('priceModels')).ok).toBe(true);
    const b = setup(() => Promise.resolve(json({ models: [] })));
    expect((await b.client.get('priceModels')).ok).toBe(true);
  });
});
