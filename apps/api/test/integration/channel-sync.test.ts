import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { addDays, todayIn } from '../../src/modules/rates/dates.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { createHarness, type Client, type Harness } from './harness.js';

/**
 * Booking.com via Zodomus, end to end, against a scripted fake of the Zodomus API (no network, so no
 * test can ever change real inventory). Payload shapes follow the authenticated API reference.
 */
const API_USER = 'fake-zodomus-user-m5';
const API_PASS = 'fake-zodomus-pass-m5';
const ENV = { ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: API_USER, ZODOMUS_API_PASSWORD: API_PASS, ZODOMUS_BASE_URL: 'https://zodomus.fake.test' };
// Channel property ids are unique platform-wide and the test database persists between runs.
const PID = String(100_000 + Math.floor(Math.random() * 899_999_999));
const OK = { status: { returnCode: 200, returnMessage: 'OK', channelLogId: '', channelOtherMessages: '', timestamp: '2026-10-17 10:00:00' } };
const ROOM_RATES = {
  ...OK,
  rooms: [
    { id: 90001, name: 'Double Room', rates: [{ id: '99001', name: 'Standard Rate', active: '1', maxPersons: 2, policy: 'Flexible', policyId: 1 }, { id: '99002', name: 'Non-refundable', active: '1', maxPersons: 2 }] },
    { id: 90002, name: 'Family Suite', rates: [{ id: '99003', name: 'Standard Rate', active: '1', maxPersons: 4 }] },
  ],
};

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];
const overrides: Record<string, { status: number; body: unknown }[]> = {};
const fakeFetch: FetchLike = (url, init) => {
  const u = new URL(url);
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  seen.push({ method: init.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const key = `${init.method} ${u.pathname}`;
  const o = overrides[key]?.shift();
  const reply = o ?? { status: 200, body: u.pathname === '/room-rates' ? ROOM_RATES : OK };
  return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }));
};
const STARTED = new Date();
// Only this run's property: the shared test database may hold due jobs from earlier runs, which the worker also sends.
const calls = (method: string, path: string) =>
  seen.filter((s) => s.method === method && s.path === path && (s.body?.['propertyId'] ?? s.query['propertyId']) === PID);

let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let roomTypeId: string;
let suiteTypeId: string;
let ratePlanId: string;
let nrPlanId: string;
let connectionId: string;
let today: string;
const base = () => `/organizations/${orgId}/properties/${propertyId}`;

async function jobs() {
  return withSystem(h.db, (tx) => tx.syncJob.findMany({ where: { connectionId }, orderBy: { createdAt: 'asc' } }));
}
async function runWorker() {
  // Run until no due job remains.
  for (let i = 0; i < 10; i++) if ((await h.services.syncWorker.runOnce()) === 0) break;
}

beforeAll(async () => {
  h = await createHarness(ENV, { channelFetch: fakeFetch });
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  const p = await owner.post(`/organizations/${orgId}/properties`, { name: 'Lake View Homestay', propertyType: 'HOMESTAY', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' });
  propertyId = p.body.data.id;
  today = todayIn('Asia/Kolkata');
  const rt = await owner.post(`${base()}/room-types`, { name: 'Deluxe Double', code: 'DLX', baseOccupancy: 2, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 });
  roomTypeId = rt.body.data.id;
  await owner.post(`${base()}/rooms/bulk`, { roomTypeId, names: ['101', '102', '103'] });
  const st = await owner.post(`${base()}/room-types`, { name: 'Family Suite', code: 'FAM', baseOccupancy: 2, maxAdults: 3, maxChildren: 1, maxOccupancy: 4 });
  suiteTypeId = st.body.data.id;
  await owner.post(`${base()}/rooms`, { roomTypeId: suiteTypeId, name: '201' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe('rate plans', () => {
  it('creates, validates and lists rate plans', async () => {
    const a = await owner.post(`${base()}/rate-plans`, { name: 'Standard', code: 'std', mealPlan: 'ROOM_ONLY' });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ code: 'STD', status: 'ACTIVE' });
    ratePlanId = a.body.data.id;
    const b = await owner.post(`${base()}/rate-plans`, { name: 'Non-refundable', code: 'NR', singleOccupancyDiscountPct: 10 });
    nrPlanId = b.body.data.id;
    expect((await owner.post(`${base()}/rate-plans`, { name: 'Dup', code: 'STD' })).status).toBe(409);
    expect((await owner.post(`${base()}/rate-plans`, { name: 'Bad', code: 'B', singleOccupancyDiscountPct: 95 })).status).toBe(400);
    const list = await owner.get(`${base()}/rate-plans`);
    expect(list.body.data.map((x: { code: string }) => x.code)).toEqual(['NR', 'STD']);
  });
});

describe('inventory & rates calendar', () => {
  it('defaults availability to rooms in service', async () => {
    const cal = await owner.get(`${base()}/calendar?days=7`);
    expect(cal.status).toBe(200);
    expect(cal.body.data.from).toBe(today);
    const dlx = cal.body.data.roomTypes.find((r: { id: string }) => r.id === roomTypeId);
    expect(dlx.roomsInService).toBe(3);
    expect(dlx.days[0]).toMatchObject({ available: 3, override: null, stopSell: false });
    expect(dlx.rates.find((r: { ratePlanId: string }) => r.ratePlanId === ratePlanId).days[0].price).toBeNull();
  });

  it('bulk-updates prices, restrictions and availability; caps overrides at rooms in service', async () => {
    const res = await owner.send('put', `${base()}/calendar`, {
      from: today,
      to: addDays(today, 9),
      roomTypeIds: [roomTypeId],
      ratePlanIds: [ratePlanId],
      rates: { price: 4500, priceSingle: 3800, minStay: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dates: 10, syncJobsQueued: 0 });
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 1), to: addDays(today, 2), roomTypeIds: [roomTypeId], availability: { available: 2 } });
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 3), to: addDays(today, 3), roomTypeIds: [roomTypeId], availability: { stopSell: true } });
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 4), to: addDays(today, 4), roomTypeIds: [roomTypeId], availability: { available: 50 } });
    const cal = await owner.get(`${base()}/calendar?days=6`);
    const dlx = cal.body.data.roomTypes.find((r: { id: string }) => r.id === roomTypeId);
    expect(dlx.days.map((d: { available: number }) => d.available)).toEqual([3, 2, 2, 0, 3, 3]);
    expect(dlx.days[4].override).toBe(50);
    const std = dlx.rates.find((r: { ratePlanId: string }) => r.ratePlanId === ratePlanId).days[0];
    expect(std).toMatchObject({ price: 4500, priceSingle: 3800, minStay: 1, closed: false });
  });

  it('only changes the fields sent, and respects weekdays', async () => {
    await owner.send('put', `${base()}/calendar`, { from: today, to: addDays(today, 6), weekdays: [6], roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { closed: true } });
    const cal = await owner.get(`${base()}/calendar?days=7`);
    const days = cal.body.data.roomTypes.find((r: { id: string }) => r.id === roomTypeId).rates.find((r: { ratePlanId: string }) => r.ratePlanId === ratePlanId).days;
    for (const d of days as { date: string; price: number; closed: boolean }[]) {
      expect(d.price).toBe(4500);
      expect(d.closed).toBe(new Date(`${d.date}T00:00:00Z`).getUTCDay() === 6);
    }
    await owner.send('put', `${base()}/calendar`, { from: today, to: addDays(today, 6), roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { closed: false } });
  });

  it('rejects past dates, bad ranges and foreign room types', async () => {
    expect((await owner.send('put', `${base()}/calendar`, { from: addDays(today, -1), to: today, roomTypeIds: [roomTypeId], availability: { available: 1 } })).body.error.code).toBe('PAST_DATE');
    expect((await owner.send('put', `${base()}/calendar`, { from: addDays(today, 5), to: today, roomTypeIds: [roomTypeId], availability: { available: 1 } })).status).toBe(400);
    expect((await owner.send('put', `${base()}/calendar`, { from: today, to: today, roomTypeIds: [roomTypeId], rates: { price: 10 } })).body.error.code).toBe('RATE_PLAN_REQUIRED');
    const other = await h.createUser();
    const oc = h.client();
    await oc.login(other.email, other.password);
    const op = await oc.post(`/organizations/${other.organizationId}/properties`, { name: 'Other', propertyType: 'HOTEL', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' });
    const ort = await oc.post(`/organizations/${other.organizationId}/properties/${op.body.data.id}/room-types`, { name: 'X', code: 'X' });
    expect((await owner.send('put', `${base()}/calendar`, { from: today, to: today, roomTypeIds: [ort.body.data.id], availability: { available: 1 } })).body.error.code).toBe('UNKNOWN_ROOM_TYPE');
    // and the other tenant cannot read this calendar
    expect((await oc.get(`/organizations/${other.organizationId}/properties/${propertyId}/calendar`)).status).toBe(404);
  });

  it('lets staff change availability but not rates', async () => {
    const staff = await h.createUser({ role: 'PROPERTY_STAFF', organizationId: orgId });
    const c = h.client();
    await c.login(staff.email, staff.password);
    expect((await c.send('put', `${base()}/calendar`, { from: addDays(today, 20), to: addDays(today, 20), roomTypeIds: [roomTypeId], availability: { available: 1 } })).status).toBe(200);
    expect((await c.send('put', `${base()}/calendar`, { from: addDays(today, 20), to: addDays(today, 20), roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { price: 1 } })).status).toBe(403);
    expect((await c.post(`${base()}/rate-plans`, { name: 'Staff', code: 'STF' })).status).toBe(403);
  });
});

describe('Booking.com connection', () => {
  it('offers Booking.com with its price models', async () => {
    const res = await owner.get(`/organizations/${orgId}/channel-options`);
    expect(res.body.data.ready).toBe(true);
    expect(res.body.data.channels[0]).toMatchObject({ channelId: 1, name: 'Booking.com' });
    expect(res.body.data.channels[0].priceModels.map((m: { id: number }) => m.id).sort()).toEqual([1, 2]);
  });

  it('activates the property (POST /property-activation) and loads rooms and rates', async () => {
    const res = await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: PID, priceModelId: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.result).toMatchObject({ ok: true, providerCode: 200 });
    expect(res.body.data.connection).toMatchObject({ status: 'ACTIVATED', channelName: 'Booking.com', currency: 'INR', environment: 'sandbox' });
    expect(res.body.data.connection.channelRooms).toHaveLength(2);
    expect(res.body.data.connection.channelRooms[0]).toEqual({
      id: '90001',
      name: 'Double Room',
      rates: [
        { id: '99001', name: 'Standard Rate', active: true, maxPersons: 2 },
        { id: '99002', name: 'Non-refundable', active: true, maxPersons: 2 },
      ],
    });
    connectionId = res.body.data.connection.id;
    expect(calls('POST', '/property-activation')[0]!.body).toEqual({ channelId: 1, propertyId: PID, priceModelId: 1 });
    expect(calls('GET', '/room-rates')[0]!.query).toEqual({ channelId: '1', propertyId: PID });
  });

  it('refuses a second Booking.com connection for the property and an unsupported price model', async () => {
    expect((await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: '999', priceModelId: 1 })).body.error.code).toBe('ALREADY_CONNECTED');
    expect((await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: '999', priceModelId: 3 })).body.error.code).toBe('UNSUPPORTED_PRICE_MODEL');
  });

  it('keeps a Booking.com property id connected to one StaySync account only', async () => {
    const other = await h.createUser();
    const oc = h.client();
    await oc.login(other.email, other.password);
    const op = await oc.post(`/organizations/${other.organizationId}/properties`, { name: 'Copycat', propertyType: 'HOTEL', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' });
    const res = await oc.post(`/organizations/${other.organizationId}/properties/${op.body.data.id}/channel-connections`, { channelId: 1, channelPropertyId: PID, priceModelId: 1 });
    expect(res.status).toBe(409);
    // ...and cannot see this tenant's connection
    expect((await oc.get(`/organizations/${other.organizationId}/properties/${propertyId}/channel-connections`)).status).toBe(404);
  });

  it('validates the mapping against the loaded channel rooms and this property', async () => {
    const url = `${base()}/channel-connections/${connectionId}/mapping`;
    expect((await owner.send('put', url, { rooms: [{ channelRoomId: '77777', roomTypeId, rates: [{ channelRateId: '99001', ratePlanId }] }] })).body.error.code).toBe('UNKNOWN_CHANNEL_ROOM');
    expect((await owner.send('put', url, { rooms: [{ channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99003', ratePlanId }] }] })).body.error.code).toBe('UNKNOWN_CHANNEL_RATE');
    expect(
      (
        await owner.send('put', url, {
          rooms: [
            { channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99001', ratePlanId }] },
            { channelRoomId: '90002', roomTypeId, rates: [{ channelRateId: '99003', ratePlanId }] },
          ],
        })
      ).body.error.code,
    ).toBe('DUPLICATE_ROOM_TYPE');
    expect(calls('POST', '/rooms-activation')).toHaveLength(0);
  });

  it('maps rooms and rates, activates rooms, and becomes ACTIVE with a one-year sync queued', async () => {
    const res = await owner.send('put', `${base()}/channel-connections/${connectionId}/mapping`, {
      rooms: [
        { channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99001', ratePlanId }, { channelRateId: '99002', ratePlanId: nrPlanId }] },
        { channelRoomId: '90002', roomTypeId: suiteTypeId, rates: [{ channelRateId: '99003', ratePlanId }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.steps.map((s: { step: string; result: { ok: boolean } }) => `${s.step}:${s.result.ok}`)).toEqual(['property-check:true', 'rooms-activation:true', 'property-check:true']);
    expect(res.body.data.connection.status).toBe('ACTIVE');
    expect(res.body.data.syncJobsQueued).toBe(5); // 2 availability + 3 rates (price model 1: no derived jobs)
    expect(calls('POST', '/rooms-activation')[0]!.body).toEqual({
      channelId: 1,
      propertyId: PID,
      rooms: [
        { roomId: '90001', roomName: 'Double Room', quantity: 3, status: 1, rates: ['99001', '99002'] },
        { roomId: '90002', roomName: 'Family Suite', quantity: 1, status: 1, rates: ['99003'] },
      ],
    });
    const j = await jobs();
    expect(j.every((x) => x.status === 'PENDING')).toBe(true);
    const avail = j.find((x) => x.kind === 'AVAILABILITY' && x.roomTypeId === roomTypeId)!;
    expect(avail.dateFrom.toISOString().slice(0, 10)).toBe(today);
    expect(avail.dateTo.toISOString().slice(0, 10)).toBe(addDays(today, 365));
  });

  it('sends one year of availability as compressed ranges (dateTo exclusive) and only priced dates as rates', async () => {
    seen.length = 0;
    await runWorker();
    const j = await jobs();
    expect(j.map((x) => x.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);

    const dlxAvail = calls('POST', '/availability').filter((c) => c.body!['roomId'] === '90001').map((c) => [c.body!['dateFrom'], c.body!['dateTo'], c.body!['availability']]);
    // today 3 | +1..+2 → 2 | +3 stop-sell → 0 | +4 (override 50 capped) … +19 → 3 | +20 (staff set 1) → 1 | rest 3
    expect(dlxAvail).toEqual([
      [today, addDays(today, 1), 3],
      [addDays(today, 1), addDays(today, 3), 2],
      [addDays(today, 3), addDays(today, 4), 0],
      [addDays(today, 4), addDays(today, 20), 3],
      [addDays(today, 20), addDays(today, 21), 1],
      [addDays(today, 21), addDays(today, 365), 3],
    ]);
    const suiteAvail = calls('POST', '/availability').filter((c) => c.body!['roomId'] === '90002');
    expect(suiteAvail.map((c) => [c.body!['dateFrom'], c.body!['dateTo'], c.body!['availability']])).toEqual([[today, addDays(today, 365), 1]]);

    const rates = calls('POST', '/rates');
    // Only the Standard plan on the Deluxe room has prices (10 days); unpriced plans send nothing.
    expect(rates).toHaveLength(1);
    expect(rates[0]!.body).toEqual({
      channelId: 1,
      propertyId: PID,
      roomId: '90001',
      rateId: '99001',
      dateFrom: today,
      dateTo: addDays(today, 10),
      currencyCode: 'INR',
      prices: { price: '4500.00', priceSingle: '3800.00' },
      closed: '0',
      closedOnArrival: '0',
      closedOnDeparture: '0',
      minimumStay: '1',
    });
    expect(calls('POST', '/rates-derived')).toHaveLength(0);
  });

  it('queues and sends only the changed range after a calendar edit, merging edits made before the worker runs', async () => {
    seen.length = 0;
    const r1 = await owner.send('put', `${base()}/calendar`, { from: addDays(today, 30), to: addDays(today, 31), roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { price: 5200 } });
    expect(r1.body.data.syncJobsQueued).toBe(1);
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 40), to: addDays(today, 40), roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { price: 6000 } });
    const pending = (await jobs()).filter((x) => x.status === 'PENDING');
    expect(pending).toHaveLength(1);
    expect([pending[0]!.dateFrom.toISOString().slice(0, 10), pending[0]!.dateTo.toISOString().slice(0, 10)]).toEqual([addDays(today, 30), addDays(today, 41)]);
    await runWorker();
    const rates = calls('POST', '/rates').map((c) => [c.body!['dateFrom'], c.body!['dateTo'], (c.body!['prices'] as { price: string }).price]);
    expect(rates).toEqual([
      [addDays(today, 30), addDays(today, 32), '5200.00'],
      [addDays(today, 40), addDays(today, 41), '6000.00'],
    ]);
  });

  it('re-sends availability when a room goes out of service', async () => {
    seen.length = 0;
    const rooms = await owner.get(`${base()}/rooms`);
    const r101 = rooms.body.data.find((r: { name: string }) => r.name === '101');
    await owner.send('patch', `${base()}/rooms/${r101.id}`, { status: 'OUT_OF_SERVICE' });
    await runWorker();
    const first = calls('POST', '/availability').find((c) => c.body!['roomId'] === '90001')!;
    expect(first.body).toMatchObject({ dateFrom: today, availability: 2 });
    await owner.send('patch', `${base()}/rooms/${r101.id}`, { status: 'AVAILABLE' });
    await runWorker();
  });

  it('retries transient failures with backoff and fails fast on validation errors and Zodomus errors in HTTP 200', async () => {
    overrides['POST /availability'] = [
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ];
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 50), to: addDays(today, 50), roomTypeIds: [roomTypeId], availability: { available: 1 } });
    await h.services.syncWorker.runOnce();
    let j = (await jobs()).at(-1)!;
    expect(j).toMatchObject({ kind: 'AVAILABILITY', status: 'PENDING', attempts: 1 });
    expect(j.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(j.lastError).toContain('server error');

    overrides['POST /rates'] = [{ status: 200, body: { status: { returnCode: 400, returnMessage: 'Invalid rate for room' } } }];
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 60), to: addDays(today, 60), roomTypeIds: [roomTypeId], ratePlanIds: [ratePlanId], rates: { price: 4100 } });
    await h.services.syncWorker.runOnce();
    j = (await jobs()).find((x) => x.kind === 'RATES' && x.lastError?.includes('Invalid rate'))!;
    expect(j).toMatchObject({ status: 'FAILED', providerCode: 400 });
    // clean up the pending retry so later tests start clean
    await withSystem(h.db, (tx) => tx.syncJob.updateMany({ where: { connectionId, status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } }));
    await runWorker();
  });

  it('records each Zodomus write as metadata only, with no credentials anywhere', async () => {
    const logs = await withSystem(h.db, (tx) => tx.integrationCallLog.findMany({ where: { httpMethod: 'POST', createdAt: { gte: STARTED } }, take: 500 }));
    expect(new Set(logs.map((l) => l.path))).toEqual(new Set(['/property-activation', '/property-check', '/rooms-activation', '/availability', '/rates']));
    const audits = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, action: { startsWith: 'channel.' } } }));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['channel.connection.created', 'channel.property.activated', 'channel.mapping.saved', 'channel.rooms.activated']));
    const everything = JSON.stringify(logs) + JSON.stringify(audits) + h.logLines.join('\n');
    expect(everything).not.toContain(API_PASS);
    expect(everything).not.toContain(Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'));
    expect(everything).not.toContain('4500.00'); // request bodies are never logged
  });

  it('shows the real connection on the owner channels overview', async () => {
    const res = await owner.get(`/organizations/${orgId}/channels`);
    const p = res.body.data.properties.find((x: { id: string }) => x.id === propertyId);
    expect(p.connections).toEqual([expect.objectContaining({ channelName: 'Booking.com', channelPropertyId: PID, status: 'ACTIVE', mappedRooms: 2 })]);
    expect(res.body.data.plan.channelsInUse).toBe(1);
  });

  it('protects mapped room types and rate plans from deletion', async () => {
    expect((await owner.send('delete', `${base()}/rate-plans/${ratePlanId}`)).body.error.code).toBe('RATE_PLAN_MAPPED');
  });

  it('disconnects (POST /property-cancellation) and cancels pending jobs', async () => {
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 70), to: addDays(today, 70), roomTypeIds: [roomTypeId], availability: { available: 1 } });
    const res = await owner.send('delete', `${base()}/channel-connections/${connectionId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.connection.status).toBe('DISCONNECTED');
    expect(calls('POST', '/property-cancellation')[0]!.body).toEqual({ channelId: 1, propertyId: PID });
    expect((await jobs()).filter((x) => x.status === 'PENDING')).toHaveLength(0);
    // later calendar edits no longer queue anything
    const r = await owner.send('put', `${base()}/calendar`, { from: addDays(today, 71), to: addDays(today, 71), roomTypeIds: [roomTypeId], availability: { available: 1 } });
    expect(r.body.data.syncJobsQueued).toBe(0);
  });
});

describe('property confirmation (property-check)', () => {
  it('does not stop on a failing first check, waits when the final check fails, and completes on a later successful check', async () => {
    seen.length = 0;
    const c = await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: PID, priceModelId: 1 });
    expect(c.status).toBe(201);
    const id = c.body.data.connection.id as string;
    const notReady = { status: 200, body: { status: { returnCode: 400, returnMessage: 'Property not active yet' } } };
    overrides['POST /property-check'] = [notReady, notReady];
    const m = await owner.send('put', `${base()}/channel-connections/${id}/mapping`, { rooms: [{ channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99001', ratePlanId }] }] });
    expect(m.status).toBe(200);
    expect(calls('POST', '/rooms-activation')).toHaveLength(1); // the failing first check did not block activation
    expect(m.body.data.connection.status).toBe('ACTIVATED');
    expect(m.body.data.connection.lastError).toContain('Property not active yet');
    expect(m.body.data.syncJobsQueued).toBe(0);

    const chk = await owner.post(`${base()}/channel-connections/${id}/check`);
    expect(chk.body.data.connection.status).toBe('ACTIVE');
    expect(chk.body.data.connection.lastError).toBeNull();
    expect(chk.body.data.syncJobsQueued).toBe(2); // 1 availability + 1 rate mapping
    connectionId = id;
    await runWorker();
    await owner.send('delete', `${base()}/channel-connections/${id}`);
  });
});

describe('derived pricing (price model 2)', () => {
  it('sends POST /rates-derived with the base occupancy and the single-guest discount', async () => {
    // Reconnect the same property with model 2 (the old connection is disconnected).
    seen.length = 0;
    const c = await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: PID, priceModelId: 2 });
    expect(c.status).toBe(201);
    const id = c.body.data.connection.id;
    const m = await owner.send('put', `${base()}/channel-connections/${id}/mapping`, { rooms: [{ channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99002', ratePlanId: nrPlanId }] }] });
    expect(m.body.data.syncJobsQueued).toBe(3); // availability + derived + rates
    connectionId = id;
    await runWorker();
    expect(calls('POST', '/rates-derived')[0]!.body).toEqual({
      channelId: 1,
      propertyId: PID,
      roomId: '90001',
      rateId: '99002',
      baseOccupancy: '2',
      occupancy: [{ persons: '1', percentage: '-10', round: '1' }],
    });
  });
});
