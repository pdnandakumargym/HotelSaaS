import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { addDays, todayIn } from '../../src/modules/rates/dates.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { createHarness, type Client, type Harness } from './harness.js';

/**
 * Beds24 as a second channel manager next to Zodomus, end to end, against scripted fakes of both APIs
 * (no network: no test can change real inventory). Shapes follow the Beds24 API v2 reference (apiV2.yaml).
 */
const ZENV = { ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: 'fake-z-user-b24', ZODOMUS_API_PASSWORD: 'fake-z-pass-b24', ZODOMUS_BASE_URL: 'https://zodomus.fake.test' };
const ZPID = String(100_000 + Math.floor(Math.random() * 899_999_999));
const BPID = String(200_000 + Math.floor(Math.random() * 799_999));
const ROOM_A = 501001;
const ROOM_B = 501002;
const ACCESS = 'fake-beds24-access-token';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}
const zSeen: Seen[] = [];
const bSeen: Seen[] = [];
let bookings: Record<string, unknown>[] = [];

const zOK = { status: { returnCode: 200, returnMessage: 'OK' } };
const zodomusFetch: FetchLike = (url, init) => {
  const u = new URL(url);
  zSeen.push({ method: init.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
  const body =
    u.pathname === '/room-rates'
      ? { ...zOK, rooms: [{ id: 90001, name: 'Double Room', rates: [{ id: '99001', name: 'Standard Rate', active: '1', maxPersons: 2 }] }] }
      : u.pathname === '/reservations-queue'
        ? { ...zOK, reservations: [] }
        : u.pathname === '/reservations-summary'
          ? { ...zOK, reservations: [] }
          : zOK;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
};

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-fivemincreditlimit': '100', 'x-fivemincreditlimit-remaining': '90', 'x-fivemincreditlimit-resetsin': '120', 'x-requestcost': '1', ...extra } }));
const beds24Fetch: FetchLike = (url, init) => {
  const u = new URL(url);
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  bSeen.push({ method: init.method ?? 'GET', path: u.pathname.replace('/api/v2', ''), query: u.searchParams, headers, body });
  const path = u.pathname.replace('/api/v2', '');
  if (path === '/authentication/token') {
    return headers['refreshtoken'] === 'fake-beds24-refresh-token' ? json(200, { token: ACCESS, expiresIn: 86400 }) : json(401, { success: false, type: 'error', code: 401, error: 'bad token' });
  }
  if (headers['token'] !== ACCESS) return json(401, { success: false, type: 'error', code: 401, error: 'Token is missing or invalid' });
  if (path === '/authentication/details') return json(200, { validToken: true, scopes: ['read:bookings', 'all:inventory'] });
  if (path === '/properties') {
    const id = u.searchParams.get('id');
    const data =
      id === BPID
        ? [{ id: Number(BPID), name: 'Lake View (Beds24)', roomTypes: [{ id: ROOM_A, name: 'Double Room', qty: 3, priceRules: [{ id: 1, name: 'Standard' }, { id: 2, name: 'Non-refundable' }] }, { id: ROOM_B, name: 'Suite', qty: 1 }] }]
        : [];
    return json(200, { success: true, type: 'property', count: data.length, pages: { nextPageExists: false, nextPageLink: null }, data });
  }
  if (path === '/inventory/rooms/calendar' && init.method === 'POST') {
    return json(201, (body as unknown[]).map(() => ({ success: true, modified: 1, errors: [], warnings: [] })));
  }
  if (path === '/bookings') {
    const ids = u.searchParams.getAll('id');
    const data = bookings.filter((b) => String(b['propertyId']) === u.searchParams.get('propertyId') && (!ids.length || ids.includes(String(b['id']))));
    return json(200, { success: true, type: 'booking', count: data.length, pages: { nextPageExists: false }, data });
  }
  return json(404, { success: false, type: 'error', code: 404, error: 'not found' });
};

let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let roomTypeId: string;
let suiteTypeId: string;
let stdPlan: string;
let nrPlan: string;
let zConn: string;
let bConn: string;
let today: string;
const base = () => `/organizations/${orgId}/properties/${propertyId}`;
const runWorker = async () => {
  for (let i = 0; i < 10; i++) if ((await h.services.syncWorker.runOnce()) === 0) break;
};
const calendarPosts = () =>
  bSeen
    .filter((s) => s.method === 'POST' && s.path === '/inventory/rooms/calendar')
    .flatMap((s) => s.body as { roomId: number; calendar: Record<string, unknown>[] }[])
    .filter((x) => x.roomId === ROOM_A || x.roomId === ROOM_B);

beforeAll(async () => {
  h = await createHarness(ZENV, { channelFetch: zodomusFetch, beds24: { fetch: beds24Fetch } });
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  const p = await owner.post(`/organizations/${orgId}/properties`, { name: 'Lake View', propertyType: 'HOMESTAY', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' });
  propertyId = p.body.data.id;
  today = todayIn('Asia/Kolkata');
  roomTypeId = (await owner.post(`${base()}/room-types`, { name: 'Deluxe Double', code: 'DLX', baseOccupancy: 2, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 })).body.data.id;
  await owner.post(`${base()}/rooms/bulk`, { roomTypeId, names: ['101', '102', '103'] });
  suiteTypeId = (await owner.post(`${base()}/room-types`, { name: 'Suite', code: 'STE', baseOccupancy: 2, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 })).body.data.id;
  await owner.post(`${base()}/rooms`, { roomTypeId: suiteTypeId, name: '201' });
  stdPlan = (await owner.post(`${base()}/rate-plans`, { name: 'Standard', code: 'STD' })).body.data.id;
  nrPlan = (await owner.post(`${base()}/rate-plans`, { name: 'Non-refundable', code: 'NR' })).body.data.id;
  await owner.send('put', `${base()}/calendar`, { from: today, to: addDays(today, 3), roomTypeIds: [roomTypeId, suiteTypeId], ratePlanIds: [stdPlan, nrPlan], rates: { price: 4000 } });
});
afterAll(async () => {
  await h?.close();
});

describe('Beds24 next to Zodomus', () => {
  it('lists both channel managers; Zodomus stays the default', async () => {
    const r = await owner.get(`/organizations/${orgId}/channel-options`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ready: true, environment: 'sandbox', channels: [{ channelId: 1, name: 'Booking.com' }] });
    expect(r.body.data.providers.map((p: { id: string; ready: boolean }) => [p.id, p.ready])).toEqual([
      ['zodomus', true],
      ['beds24', true],
    ]);
  });

  it('connects Booking.com through Zodomus exactly as before (no provider field)', async () => {
    const c = await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: ZPID, priceModelId: 2 });
    expect(c.status).toBe(201);
    zConn = c.body.data.connection.id;
    expect(c.body.data.connection).toMatchObject({ provider: 'zodomus', status: 'ACTIVATED', environment: 'sandbox' });
    const m = await owner.send('put', `${base()}/channel-connections/${zConn}/mapping`, { rooms: [{ channelRoomId: '90001', roomTypeId, rates: [{ channelRateId: '99001', ratePlanId: stdPlan }] }] });
    expect(m.status).toBe(200);
    expect(m.body.data.connection.status).toBe('ACTIVE');
    expect(bSeen).toHaveLength(0); // nothing went to Beds24
  });

  it('rejects an unknown Beds24 property id without creating anything at Beds24', async () => {
    const c = await owner.post(`${base()}/channel-connections`, { provider: 'beds24', channelId: 1, channelPropertyId: String(Number(BPID) + 1), priceModelId: 1 });
    expect(c.status).toBe(201);
    expect(c.body.data.connection).toMatchObject({ provider: 'beds24', status: 'DRAFT' });
    expect(c.body.data.connection.lastError).toContain('not in the account');
    bConn = c.body.data.connection.id;
    // Fix the id: disconnect the draft and connect again.
    expect((await owner.send('delete', `${base()}/channel-connections/${bConn}`)).status).toBe(200);
  });

  it('connects a Beds24 property, loads its rooms and price slots, and maps them', async () => {
    const zBefore = zSeen.length;
    const c = await owner.post(`${base()}/channel-connections`, { provider: 'beds24', channelId: 1, channelPropertyId: BPID, priceModelId: 1 });
    expect(c.status).toBe(201);
    bConn = c.body.data.connection.id;
    expect(c.body.data.connection).toMatchObject({ provider: 'beds24', channelName: 'Beds24', status: 'ACTIVATED', environment: 'production' });
    expect(c.body.data.connection.channelRooms).toEqual([
      { id: String(ROOM_A), name: 'Double Room', rates: [{ id: 'price1', name: 'Standard', active: null, maxPersons: null }, { id: 'price2', name: 'Non-refundable', active: null, maxPersons: null }] },
      { id: String(ROOM_B), name: 'Suite', rates: [{ id: 'price1', name: 'Price 1 (calendar default price)', active: null, maxPersons: null }] },
    ]);
    // Token handling: the refresh token is exchanged once; API calls carry only the access token.
    const props = bSeen.find((s) => s.path === '/properties')!;
    expect(props.headers['token']).toBe(ACCESS);
    expect(props.headers['refreshtoken']).toBeUndefined();
    expect(props.query.get('includePriceRules')).toBe('true');

    const m = await owner.send('put', `${base()}/channel-connections/${bConn}/mapping`, {
      rooms: [
        { channelRoomId: String(ROOM_A), roomTypeId, rates: [{ channelRateId: 'price1', ratePlanId: stdPlan }, { channelRateId: 'price2', ratePlanId: nrPlan }] },
        { channelRoomId: String(ROOM_B), roomTypeId: suiteTypeId, rates: [{ channelRateId: 'price1', ratePlanId: stdPlan }] },
      ],
    });
    expect(m.status).toBe(200);
    expect(m.body.data.connection.status).toBe('ACTIVE');
    expect(m.body.data.syncJobsQueued).toBeGreaterThan(0);
    expect(zSeen.length).toBe(zBefore); // nothing went to Zodomus
  });

  it('sends availability and prices to the Beds24 calendar, and Zodomus jobs still go to Zodomus', async () => {
    const zBefore = zSeen.length;
    await owner.send('put', `${base()}/calendar`, { from: today, to: addDays(today, 1), roomTypeIds: [roomTypeId], ratePlanIds: [stdPlan], rates: { price: 4500, minStay: 2, closedOnArrival: true } });
    await runWorker();
    const posts = calendarPosts();
    expect(posts.length).toBeGreaterThan(0);
    // Availability of the double room (3 rooms) from today, `to` inclusive (confirmed rule in this setup).
    const avail = posts.find((p) => p.roomId === ROOM_A && p.calendar[0]!['numAvail'] !== undefined && p.calendar[0]!['from'] === today)!;
    expect(avail.calendar[0]).toMatchObject({ from: today, numAvail: 3 });
    expect(String(avail.calendar[0]!['to']) >= today).toBe(true);
    // price1 carries the restrictions; Beds24 keeps them per room.
    const p1 = posts.filter((p) => p.roomId === ROOM_A && 'price1' in p.calendar[0]!).map((p) => p.calendar[0]!);
    expect(p1).toContainEqual({ from: today, to: addDays(today, 1), price1: 4500, minStay: 2, maxStay: null, override: 'noCheckIn' });
    // price2 sends only its price.
    const p2 = posts.filter((p) => p.roomId === ROOM_A && 'price2' in p.calendar[0]!).map((p) => p.calendar[0]!);
    expect(p2.length).toBeGreaterThan(0);
    expect(Object.keys(p2[0]!).sort()).toEqual(['from', 'price2', 'to']);
    // The Zodomus connection received its own updates through Zodomus.
    expect(zSeen.slice(zBefore).some((s) => s.path === '/rates' && (s.body as { propertyId: string }).propertyId === ZPID)).toBe(true);
    const failed = await withSystem(h.db, (tx) => tx.syncJob.count({ where: { connectionId: { in: [bConn, zConn] }, status: 'FAILED' } }));
    expect(failed).toBe(0);
  });

  it('removes a closed rate price for those dates', async () => {
    bSeen.length = 0;
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 2), to: addDays(today, 2), roomTypeIds: [roomTypeId], ratePlanIds: [nrPlan], rates: { closed: true } });
    await runWorker();
    const p2 = calendarPosts().filter((p) => 'price2' in p.calendar[0]!).map((p) => p.calendar[0]!);
    expect(p2).toContainEqual({ from: addDays(today, 2), to: addDays(today, 2), price2: null });
  });

  it('imports Beds24 bookings (never card tokens), deducts availability and handles cancellations', async () => {
    const now = new Date();
    bookings = [
      {
        id: 7770001,
        propertyId: Number(BPID),
        roomId: ROOM_A,
        roomQty: 1,
        status: 'confirmed',
        arrival: addDays(today, 1),
        departure: addDays(today, 3),
        numAdult: 2,
        numChild: 0,
        firstName: 'Asha',
        lastName: 'Rao',
        email: 'asha@example.test',
        price: 9000,
        channel: 'booking',
        stripeToken: 'tok_should_never_be_stored',
        pcibookingToken: 'pci_should_never_be_stored',
        bookingTime: now.toISOString(),
        modifiedTime: now.toISOString(),
      },
    ];
    const poll = await owner.post(`${base()}/channel-connections/${bConn}/reservations/poll`);
    expect(poll.status).toBe(200);
    expect(poll.body.data).toMatchObject({ ok: true, stored: 1 });
    const q = bSeen.find((s) => s.path === '/bookings' && s.query.get('modifiedFrom'))!;
    expect(q.query.getAll('status').sort()).toEqual(['cancelled', 'confirmed', 'new', 'request']);
    expect(q.query.get('propertyId')).toBe(BPID);

    const list = await owner.get(`/organizations/${orgId}/reservations`);
    const r = list.body.data.items.find((x: { channelReservationId: string }) => x.channelReservationId === '7770001');
    expect(r).toMatchObject({ status: 'CONFIRMED', total: 9000, currency: 'INR' });
    const stored = await withSystem(h.db, (tx) => tx.reservation.findFirstOrThrow({ where: { connectionId: bConn, channelReservationId: '7770001' } }));
    expect(JSON.stringify(stored)).not.toContain('tok_should_never_be_stored');
    expect(h.logLines.join('\n')).not.toMatch(/tok_should_never|pci_should_never|asha@example/);

    // Availability for the stay nights dropped to 2 and is queued for both channel managers.
    const cal = await owner.get(`${base()}/calendar?days=4`);
    const dlx = cal.body.data.roomTypes.find((x: { id: string }) => x.id === roomTypeId);
    expect(dlx.days[1].available).toBe(2);

    // Cancellation.
    const later = new Date(now.getTime() + 60_000).toISOString();
    bookings = [{ ...bookings[0]!, status: 'cancelled', modifiedTime: later, cancelTime: later }];
    const poll2 = await owner.post(`${base()}/channel-connections/${bConn}/reservations/poll`);
    expect(poll2.body.data).toMatchObject({ ok: true, stored: 1 });
    const again = await withSystem(h.db, (tx) => tx.reservation.findFirstOrThrow({ where: { connectionId: bConn, channelReservationId: '7770001' } }));
    expect(again.status).toBe('CANCELLED');
    // The same change listed again is skipped (no second retrieval).
    const poll3 = await owner.post(`${base()}/channel-connections/${bConn}/reservations/poll`);
    expect(poll3.body.data).toMatchObject({ ok: true, stored: 0, skipped: 1 });
  });

  it('says promotions are not available through Beds24', async () => {
    const r = await owner.get(`${base()}/channel-connections/${bConn}/promotions`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_SUPPORTED');
  });

  it('records Beds24 calls as metadata only (no tokens)', async () => {
    const logs = await withSystem(h.db, (tx) => tx.integrationCallLog.findMany({ where: { provider: 'beds24' } }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.operation === 'authToken')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(ACCESS);
    expect(JSON.stringify(logs)).not.toContain('fake-beds24-refresh-token');
    expect(h.logLines.join('\n')).not.toContain(ACCESS);
  });
});

describe('Beds24 write guard', () => {
  it('refuses calendar writes until the date-range rule is confirmed', async () => {
    const h2 = await createHarness({}, { beds24: { fetch: beds24Fetch, calendarToInclusive: null } });
    try {
      const adapter = h2.services.providers.get('beds24')!;
      await expect(adapter.pushAvailability!({ channelId: 1, channelPropertyId: BPID, channelRoomId: String(ROOM_A), dateFrom: today, dateTo: addDays(today, 1), available: 1 }, {})).rejects.toThrow(/BEDS24_CALENDAR_TO_INCLUSIVE/);
    } finally {
      await h2.close();
    }
  });

  it('refuses calendar writes unless BEDS24_ALLOW_WRITES is on', async () => {
    const h3 = await createHarness({}, { beds24: { fetch: beds24Fetch, allowWrites: false } });
    try {
      const before = bSeen.length;
      const adapter = h3.services.providers.get('beds24')!;
      await expect(adapter.pushRates!({ channelId: 1, channelPropertyId: BPID, channelRoomId: String(ROOM_A), channelRateId: 'price1', currency: 'INR', dateFrom: today, dateTo: addDays(today, 1), price: '10', restrictions: {} }, {})).rejects.toThrow(/BEDS24_ALLOW_WRITES/);
      expect(bSeen.slice(before).some((s) => s.method === 'POST')).toBe(false);
    } finally {
      await h3.close();
    }
  });
});
