import { ProviderRegistry } from '../../src/modules/channels/provider-registry.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { totpAt } from '../../src/modules/auth/totp.js';
import { addDays, todayIn } from '../../src/modules/rates/dates.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { createHarness, type Client, type Harness } from './harness.js';
import { memoryLogger, testConfig } from '../helpers.js';
import { ReservationService } from '../../src/modules/reservations/reservation.service.js';
import type { ChannelProvider } from '../../src/modules/channels/channel-provider.js';

/**
 * Milestone 6: Booking.com reservations through Zodomus, against a scripted fake (no network, so no test
 * can touch real bookings or inventory). Response shapes follow the authenticated swagger.json.
 */
const ENV = { ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: 'fake-zodomus-user-m6', ZODOMUS_API_PASSWORD: 'fake-zodomus-pass-m6', ZODOMUS_BASE_URL: 'https://zodomus.fake.test' };
const PID = String(100_000 + Math.floor(Math.random() * 899_999_999));
const status = (code = 200, msg = 'OK') => ({ returnCode: code, returnMessage: msg, channelLogId: '', channelOtherMessages: '', timestamp: '2026-10-19 10:00:00' });
const OK = { status: status() };
const ROOM_RATES = {
  ...OK,
  rooms: [
    { id: 70001, name: 'Double Room', rates: [{ id: '79001', name: 'Standard Rate', active: '1', maxPersons: 2 }] },
    { id: 70002, name: 'Family Suite', rates: [{ id: '79002', name: 'Standard Rate', active: '1', maxPersons: 4 }] },
  ],
};
const GUEST_EMAIL = 'asha.rao.m6@example.test';
const GUEST_LAST = 'Raoxyzzy';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}
const seen: Seen[] = [];
let queue: { id: string; status: string; date: string }[] = [];
const bookings = new Map<string, unknown>();
let summary: unknown[] = [];
const overrides: Record<string, { status: number; body: unknown }[]> = {};

const fakeFetch: FetchLike = (url, init) => {
  const u = new URL(url);
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  seen.push({ method: init.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const o = overrides[`${init.method} ${u.pathname}`]?.shift();
  let reply: { status: number; body: unknown };
  if (o) reply = o;
  else if (u.pathname === '/room-rates') reply = { status: 200, body: ROOM_RATES };
  else if (u.pathname === '/reservations-queue') reply = { status: 200, body: { ...OK, reservations: queue } };
  else if (u.pathname === '/reservations-summary') reply = { status: 200, body: { ...OK, reservations: summary } };
  else if (u.pathname === '/reservations') {
    const b = bookings.get(u.searchParams.get('reservationId') ?? '');
    reply = { status: 200, body: { ...OK, reservations: b ? [b] : [] } };
  } else reply = { status: 200, body: OK };
  return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } }));
};
const calls = (method: string, path: string) => seen.filter((s) => s.method === method && s.path === path && (s.body?.['propertyId'] ?? s.query['propertyId']) === PID);

function booking(id: string, rooms: { roomId: number | string; from: string | null; to: string | null; guests?: string; rateId?: string; total?: string }[], extra: { status?: string; first?: string } = {}) {
  return {
    reservation: { id, status: extra.status ?? '1', currencyCode: 'INR', totalPrice: rooms.reduce((n, r) => n + Number(r.total ?? '4500.00'), 0).toFixed(2), remarks: 'Late arrival', RUID: 'ruid-1' },
    customer: { firstName: extra.first ?? 'Asha', middleName: '', lastName: GUEST_LAST, address: '1 Lake Road', city: 'Ooty', zipCode: '643001', countryCode: 'in', email: GUEST_EMAIL, phone: '+91 99999 00000', remarks: 'Vegetarian breakfast' },
    rooms: rooms.map((r) => ({
      id: r.roomId,
      name: 'Room',
      totalPrice: r.total ?? '4500.00',
      guestName: `Asha ${GUEST_LAST}`,
      numberOfGuests: r.guests ?? '2',
      ArrivalDate: r.from,
      departureDate: r.to,
      smoking: '0',
      mealPlan: 'Breakfast included',
      remarks: '',
      prices: { price: '4500.00', date: r.from, rateId: r.rateId ?? '79001', promotionId: '0', geniusRate: 'no' },
    })),
  };
}

let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let dlxId: string;
let famId: string;
let planId: string;
let connectionId: string;
let today: string;
const base = () => `/organizations/${orgId}/properties/${propertyId}`;
const conn = () => `${base()}/channel-connections/${connectionId}`;
const poll = () => owner.post(`${conn()}/reservations/poll`);
const calendarDay = async (roomTypeId: string, date: string) => {
  const cal = await owner.get(`${base()}/calendar?from=${date}&days=1`);
  return cal.body.data.roomTypes.find((r: { id: string }) => r.id === roomTypeId).days[0] as { available: number; booked: number };
};
const discrepancies = async (kind?: string, st = 'OPEN') => {
  const res = await owner.get(`/organizations/${orgId}/discrepancies?propertyId=${propertyId}&status=${st}`);
  return (res.body.data.items as { id: string; kind: string; severity: string; message: string; dedupeKey: string; occurrences: number; autoResolved: boolean; status: string }[]).filter((d) => !kind || d.kind === kind);
};
const reservationRow = (id: string) =>
  withSystem(h.db, (tx) => tx.reservation.findUnique({ where: { connectionId_channelReservationId: { connectionId, channelReservationId: id } }, include: { rooms: true } }));
async function runWorker() {
  for (let i = 0; i < 10; i++) if ((await h.services.syncWorker.runOnce()) === 0) break;
}

beforeAll(async () => {
  h = await createHarness(ENV, { channelFetch: fakeFetch });
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  const p = await owner.post(`/organizations/${orgId}/properties`, { name: 'Nilgiri Stay', propertyType: 'HOMESTAY', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' });
  propertyId = p.body.data.id;
  today = todayIn('Asia/Kolkata');
  dlxId = (await owner.post(`${base()}/room-types`, { name: 'Deluxe Double', code: 'DLX', baseOccupancy: 2, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 })).body.data.id;
  await owner.post(`${base()}/rooms/bulk`, { roomTypeId: dlxId, names: ['101', '102'] });
  famId = (await owner.post(`${base()}/room-types`, { name: 'Family Suite', code: 'FAM', baseOccupancy: 2, maxAdults: 3, maxChildren: 1, maxOccupancy: 4 })).body.data.id;
  await owner.post(`${base()}/rooms`, { roomTypeId: famId, name: '201' });
  planId = (await owner.post(`${base()}/rate-plans`, { name: 'Standard', code: 'STD' })).body.data.id;
  const c = await owner.post(`${base()}/channel-connections`, { channelId: 1, channelPropertyId: PID, priceModelId: 1 });
  connectionId = c.body.data.connection.id;
  const m = await owner.send('put', `${conn()}/mapping`, {
    rooms: [
      { channelRoomId: '70001', roomTypeId: dlxId, rates: [{ channelRateId: '79001', ratePlanId: planId }] },
      { channelRoomId: '70002', roomTypeId: famId, rates: [{ channelRateId: '79002', ratePlanId: planId }] },
    ],
  });
  expect(m.body.data.connection.status).toBe('ACTIVE');
  await runWorker();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  for (const k of Object.keys(overrides)) delete overrides[k];
});

describe('reservation queue polling', () => {
  it('imports the reservation summary once, then reads the queue and retrieves each listed booking', async () => {
    seen.length = 0;
    queue = [{ id: 'R1', status: '1', date: '2026-10-19 08:00:00' }];
    bookings.set('R1', booking('R1', [{ roomId: 70001, from: addDays(today, 2), to: addDays(today, 4) }]));
    const res = await poll();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, queued: 1, stored: 1, skipped: 0, failed: 0, summary: { ok: true, stored: 0 } });
    expect(calls('GET', '/reservations-summary')).toHaveLength(1);
    expect(calls('GET', '/reservations-queue')[0]!.query).toEqual({ channelId: '1', propertyId: PID });
    expect(calls('GET', '/reservations')[0]!.query).toEqual({ channelId: '1', propertyId: PID, reservationId: 'R1' });
    // Card data is never requested.
    expect(seen.some((s) => s.path.includes('-cc'))).toBe(false);
  });

  it('stores the booking with guest data encrypted and never logs it', async () => {
    const row = await reservationRow('R1');
    expect(row).toMatchObject({ status: 'CONFIRMED', currency: 'INR', totalMinor: 450000, guestCount: 2, roomCount: 1, needsReview: false, source: 'TEST', environment: 'sandbox' });
    expect(row!.checkIn!.toISOString().slice(0, 10)).toBe(addDays(today, 2));
    expect(row!.checkOut!.toISOString().slice(0, 10)).toBe(addDays(today, 4));
    expect(row!.rooms[0]).toMatchObject({ roomTypeId: dlxId, ratePlanId: planId, occupiesInventory: true, channelRoomId: '70001' });
    expect(row!.guestEnc).toMatch(/^v1\./);
    const rawRow = JSON.stringify(row);
    expect(rawRow).not.toContain(GUEST_EMAIL);
    expect(rawRow).not.toContain(GUEST_LAST);
    expect(h.logLines.join('\n')).not.toContain(GUEST_EMAIL);
    expect(h.logLines.join('\n')).not.toContain(GUEST_LAST);
    const audit = await withSystem(h.db, (tx) => tx.auditEvent.findFirst({ where: { organizationId: orgId, action: 'reservation.received', entityId: row!.id } }));
    expect(JSON.stringify(audit?.metadata)).not.toContain(GUEST_LAST);
  });

  it('deducts the booking from availability and sends the new availability to Booking.com', async () => {
    expect(await calendarDay(dlxId, addDays(today, 1))).toMatchObject({ booked: 0, available: 2 });
    expect(await calendarDay(dlxId, addDays(today, 2))).toMatchObject({ booked: 1, available: 1 });
    expect(await calendarDay(dlxId, addDays(today, 3))).toMatchObject({ booked: 1, available: 1 });
    expect(await calendarDay(dlxId, addDays(today, 4))).toMatchObject({ booked: 0, available: 2 });
    seen.length = 0;
    await runWorker();
    const sent = calls('POST', '/availability').map((c) => [c.body!['roomId'], c.body!['dateFrom'], c.body!['dateTo'], c.body!['availability']]);
    expect(sent).toEqual([['70001', addDays(today, 2), addDays(today, 4), 1]]);
  });

  it('skips a queue entry it already processed', async () => {
    seen.length = 0;
    const res = await poll();
    expect(res.body.data).toMatchObject({ queued: 1, stored: 0, skipped: 1 });
    expect(calls('GET', '/reservations')).toHaveLength(0);
    expect(calls('GET', '/reservations-summary')).toHaveLength(0);
  });

  it('applies a modification: releases the old nights and books the new ones', async () => {
    queue = [{ id: 'R1', status: '2', date: '2026-10-19 09:00:00' }];
    bookings.set('R1', booking('R1', [{ roomId: 70001, from: addDays(today, 5), to: addDays(today, 7) }], { status: '2' }));
    expect((await poll()).body.data.stored).toBe(1);
    const row = await reservationRow('R1');
    expect(row).toMatchObject({ status: 'MODIFIED', version: 2 });
    expect(await calendarDay(dlxId, addDays(today, 2))).toMatchObject({ booked: 0, available: 2 });
    expect(await calendarDay(dlxId, addDays(today, 5))).toMatchObject({ booked: 1, available: 1 });
    seen.length = 0;
    await runWorker();
    const sent = calls('POST', '/availability').map((c) => [c.body!['dateFrom'], c.body!['dateTo'], c.body!['availability']]);
    expect(sent).toEqual([
      [addDays(today, 2), addDays(today, 5), 2],
      [addDays(today, 5), addDays(today, 7), 1],
    ]);
  });

  it('applies a cancellation and restores availability', async () => {
    queue = [{ id: 'R1', status: '3', date: '2026-10-19 10:00:00' }];
    bookings.set('R1', { ...booking('R1', [], { status: '3' }) });
    await poll();
    const row = await reservationRow('R1');
    expect(row!.status).toBe('CANCELLED');
    expect(row!.cancelledAt).not.toBeNull();
    // Rooms kept for the record, released from inventory.
    expect(row!.rooms).toHaveLength(1);
    expect(row!.rooms[0]!.occupiesInventory).toBe(false);
    expect(await calendarDay(dlxId, addDays(today, 5))).toMatchObject({ booked: 0, available: 2 });
    expect(await discrepancies('RESERVATION_INCOMPLETE')).toHaveLength(0);
  });
});

describe('queue edge cases', () => {
  it('uses only the latest queue entry of a booking listed several times', async () => {
    seen.length = 0;
    queue = [
      { id: 'Q1', status: '1', date: 'q-a' },
      { id: 'Q1', status: '2', date: 'q-b' },
      { id: 'Q1', status: '3', date: 'q-c' },
    ];
    bookings.set('Q1', booking('Q1', [{ roomId: 70001, from: addDays(today, 80), to: addDays(today, 81) }]));
    const r = await poll();
    expect(r.body.data).toMatchObject({ queued: 1, stored: 1 });
    expect(calls('GET', '/reservations')).toHaveLength(1);
    expect(await reservationRow('Q1')).toMatchObject({ status: 'CANCELLED', version: 1, channelChangedAt: 'q-c' });
    // Polling again changes nothing.
    await poll();
    expect(await reservationRow('Q1')).toMatchObject({ status: 'CANCELLED', version: 1 });
  });

  it('handles the sandbox shape: one fixed booking object for every queue entry, total only per room', async () => {
    const fixed = booking('174465917455', [{ roomId: '70001', from: addDays(today, 90), to: addDays(today, 91), total: '260' }]);
    (fixed.reservation as Record<string, unknown>)['totalPrice'] = '0';
    (fixed.reservation as Record<string, unknown>)['status'] = 1;
    queue = [
      { id: 'SBX1', status: 1 as unknown as string, date: '2026-10-19' },
      { id: 'SBX2', status: 1 as unknown as string, date: '2026-10-19' },
    ];
    overrides['GET /reservations'] = [
      { status: 200, body: { ...OK, reservations: fixed } },
      { status: 200, body: { ...OK, reservations: fixed } },
    ];
    const r = await poll();
    expect(r.body.data).toMatchObject({ queued: 2, stored: 2, failed: 0 });
    for (const id of ['SBX1', 'SBX2']) expect(await reservationRow(id)).toMatchObject({ status: 'CONFIRMED', totalMinor: 26000, needsReview: false });
    expect(await reservationRow('174465917455')).toBeNull();
    queue = [];
  });

  it('stores past stays from the summary without opening discrepancies', async () => {
    const before = (await discrepancies()).length;
    summary = [booking('OLD1', [{ roomId: 90003, from: '2019-05-20', to: '2019-05-22' }])];
    expect((await owner.post(`${conn()}/reservations/import-summary`)).body.data.stored).toBe(1);
    expect(await reservationRow('OLD1')).toMatchObject({ needsReview: true });
    expect((await discrepancies()).length).toBe(before);
    summary = [];
  });

  it('handles a manual fetch running at the same time as the background poller', async () => {
    queue = [{ id: 'Q2', status: '1', date: 'q-a' }];
    bookings.set('Q2', booking('Q2', [{ roomId: 70001, from: addDays(today, 85), to: addDays(today, 86) }]));
    const [a, b] = await Promise.all([poll(), h.services.reservations.pollAll()]);
    expect(a.status).toBe(200);
    expect(b.find((x) => x.connectionId === connectionId)?.ok ?? true).toBe(true);
    expect(await reservationRow('Q2')).toMatchObject({ status: 'CONFIRMED', version: 1 });
    queue = [];
  });
});

describe('discrepancies from bookings', () => {
  it('flags a booking for an unmapped Booking.com room and does not deduct it', async () => {
    queue = [{ id: 'R2', status: '1', date: 'd1' }];
    bookings.set('R2', booking('R2', [{ roomId: 75555, from: addDays(today, 3), to: addDays(today, 4) }]));
    await poll();
    const row = await reservationRow('R2');
    expect(row).toMatchObject({ needsReview: true });
    expect(row!.reviewReason).toContain('Not mapped');
    expect(row!.rooms[0]).toMatchObject({ roomTypeId: null, occupiesInventory: false });
    const d = await discrepancies('UNMAPPED_ROOM');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'high' });
    expect(d[0]!.message).toContain('75555');
    expect(d[0]!.message).not.toContain(GUEST_LAST);
  });

  it('never guesses unrecognised dates: the booking needs review and nothing is deducted', async () => {
    queue = [{ id: 'R3', status: '1', date: 'd1' }];
    bookings.set('R3', booking('R3', [{ roomId: 70001, from: '20/12/2026', to: '22/12/2026' }]));
    await poll();
    const row = await reservationRow('R3');
    expect(row).toMatchObject({ needsReview: true, checkIn: null, checkOut: null });
    expect(row!.rooms[0]).toMatchObject({ occupiesInventory: false, roomTypeId: dlxId });
    expect((await discrepancies('RESERVATION_INCOMPLETE')).map((x) => x.message).join()).toContain('unrecognised format');
  });

  it('accepts dates with a time part', async () => {
    queue = [{ id: 'R3b', status: '1', date: 'd1' }];
    bookings.set('R3b', booking('R3b', [{ roomId: 70001, from: `${addDays(today, 40)} 14:00:00`, to: `${addDays(today, 41)}T11:00:00` }]));
    await poll();
    const row = await reservationRow('R3b');
    expect(row).toMatchObject({ needsReview: false });
    expect(row!.checkIn!.toISOString().slice(0, 10)).toBe(addDays(today, 40));
  });

  it('opens an overbooking when more rooms are booked than exist, and resolves it when one is cancelled', async () => {
    queue = [
      { id: 'R4', status: '1', date: 'd1' },
      { id: 'R5', status: '1', date: 'd1' },
    ];
    bookings.set('R4', booking('R4', [{ roomId: 70002, from: addDays(today, 10), to: addDays(today, 12), rateId: '79002' }]));
    bookings.set('R5', booking('R5', [{ roomId: 70002, from: addDays(today, 11), to: addDays(today, 13), rateId: '79002' }]));
    await poll();
    expect(await calendarDay(famId, addDays(today, 11))).toMatchObject({ booked: 2, available: 0 });
    const over = await discrepancies('OVERBOOKING');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ severity: 'high', dedupeKey: `overbooking:${famId}` });
    expect(over[0]!.message).toContain('2 booked but 1 in service');

    queue = [{ id: 'R5', status: '3', date: 'd2' }];
    bookings.set('R5', booking('R5', [{ roomId: 70002, from: addDays(today, 11), to: addDays(today, 13), rateId: '79002' }], { status: '3' }));
    await poll();
    expect(await discrepancies('OVERBOOKING')).toHaveLength(0);
    const resolved = await discrepancies('OVERBOOKING', 'RESOLVED');
    expect(resolved[0]).toMatchObject({ autoResolved: true });
  });

  it('reports a booking that cannot be retrieved, and resolves it once retrieved', async () => {
    queue = [{ id: 'R6', status: '1', date: 'd1' }];
    bookings.set('R6', booking('R6', [{ roomId: 70001, from: addDays(today, 20), to: addDays(today, 21) }]));
    overrides['GET /reservations'] = [{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }];
    const r = await poll();
    expect(r.body.data).toMatchObject({ failed: 1, stored: 0 });
    expect(await discrepancies('RESERVATION_FETCH_FAILED')).toHaveLength(1);
    await poll();
    expect(await discrepancies('RESERVATION_FETCH_FAILED')).toHaveLength(0);
    expect(await reservationRow('R6')).not.toBeNull();
  });

  it('stores a cancellation for a booking it never received and flags it', async () => {
    queue = [{ id: 'R7', status: '3', date: 'd1' }];
    bookings.set('R7', booking('R7', [{ roomId: 70001, from: addDays(today, 30), to: addDays(today, 31) }], { status: '3' }));
    await poll();
    expect((await reservationRow('R7'))!.status).toBe('CANCELLED');
    expect(await discrepancies('UNKNOWN_RESERVATION')).toHaveLength(1);
  });

  it('alerts after three failed queue reads in a row and clears the alert when reading works again', async () => {
    queue = [];
    overrides['GET /reservations-queue'] = Array.from({ length: 9 }, () => ({ status: 503, body: {} }));
    for (let i = 0; i < 3; i++) expect((await poll()).body.data.ok).toBe(false);
    const d = await discrepancies('POLL_FAILED');
    expect(d).toHaveLength(1);
    delete overrides['GET /reservations-queue'];
    expect((await poll()).body.data.ok).toBe(true);
    expect(await discrepancies('POLL_FAILED')).toHaveLength(0);
  });
});

describe('summary, test bookings, background polling', () => {
  it('imports future bookings made before the connection on request', async () => {
    summary = [booking('S1', [{ roomId: 70001, from: addDays(today, 50), to: addDays(today, 52) }])];
    const r = await owner.post(`${conn()}/reservations/import-summary`);
    expect(r.body.data).toMatchObject({ ok: true, stored: 1 });
    expect((await reservationRow('S1'))!.source).toBe('SUMMARY');
    // Already known bookings are not imported twice.
    expect((await owner.post(`${conn()}/reservations/import-summary`)).body.data.stored).toBe(0);
    summary = [];
  });

  it('creates a sandbox test booking (POST /reservations-createtest) and fetches it', async () => {
    seen.length = 0;
    queue = [{ id: 'T1', status: '1', date: 'd1' }];
    bookings.set('T1', booking('T1', [{ roomId: 70001, from: addDays(today, 60), to: addDays(today, 61) }]));
    const r = await owner.post(`${conn()}/reservations/test`, { status: 'new', channelReservationId: '' });
    expect(r.status).toBe(200);
    expect(r.body.data.result).toMatchObject({ ok: true });
    expect(r.body.data.poll).toMatchObject({ stored: 1 });
    expect(calls('POST', '/reservations-createtest')[0]!.body).toEqual({ channelId: 1, propertyId: PID, status: 'new' });
    expect((await owner.post(`${conn()}/reservations/test`, { status: 'paid' })).status).toBe(400);
  });

  it('refuses test bookings when the platform uses Zodomus production', async () => {
    // A production config cannot be loaded outside NODE_ENV=production, so the service gets one directly.
    const cfg = testConfig(ENV);
    const prodConfig = { ...cfg, zodomus: { ...cfg.zodomus, environment: 'production' as const } };
    const sent: unknown[] = [];
    const provider = { id: 'zodomus', isReady: () => true, createTestReservation: (x: unknown) => (sent.push(x), Promise.resolve({ ok: true })) } as unknown as ChannelProvider;
    const svc = new ReservationService(h.db, prodConfig, new ProviderRegistry([provider]), h.services.audit, memoryLogger().logger);
    await expect(svc.createTest(orgId, connectionId, { status: 'new' }, { id: '00000000-0000-7000-8000-000000000000' }, {})).rejects.toMatchObject({ code: 'SANDBOX_ONLY', status: 409 });
    expect(sent).toHaveLength(0);
  });

  it('polls every active connection in the background', async () => {
    queue = [{ id: 'B1', status: '1', date: 'd1' }];
    bookings.set('B1', booking('B1', [{ roomId: 70001, from: addDays(today, 70), to: addDays(today, 71) }]));
    const results = await h.services.reservations.pollAll();
    expect(results.find((r) => r.connectionId === connectionId)).toMatchObject({ ok: true, stored: 1 });
    queue = [];
  });
});

describe('who can see guest details', () => {
  it('shows guest names to the owner and audits viewing guest details', async () => {
    const list = await owner.get(`/organizations/${orgId}/reservations?propertyId=${propertyId}&view=all`);
    expect(list.status).toBe(200);
    expect(list.body.data.guestDetailsVisible).toBe(true);
    const r1 = list.body.data.items.find((x: { channelReservationId: string }) => x.channelReservationId === 'R1');
    expect(r1).toMatchObject({ guestName: `Asha ${GUEST_LAST}`, status: 'CANCELLED', isTest: true, channelName: 'Booking.com' });
    const detail = await owner.get(`/organizations/${orgId}/reservations/${r1.id}`);
    expect(detail.body.data.guest).toMatchObject({ email: GUEST_EMAIL, lastName: GUEST_LAST, countryCode: 'IN', reservationRemarks: 'Late arrival' });
    expect(detail.headers['cache-control']).toBe('no-store');
    const audit = await withSystem(h.db, (tx) => tx.auditEvent.count({ where: { organizationId: orgId, action: 'reservation.guest_viewed', entityId: r1.id } }));
    expect(audit).toBe(1);
  });

  it('hides guest details from read-only members', async () => {
    const ro = await h.createUser({ role: 'READ_ONLY', organizationId: orgId });
    const c = h.client();
    await c.login(ro.email, ro.password);
    const list = await c.get(`/organizations/${orgId}/reservations?propertyId=${propertyId}&view=all`);
    expect(list.body.data.guestDetailsVisible).toBe(false);
    expect(list.body.data.items.every((x: { guestName: unknown }) => x.guestName === null)).toBe(true);
    const detail = await c.get(`/organizations/${orgId}/reservations/${list.body.data.items[0].id}`);
    expect(detail.body.data.guest).toBeNull();
    expect(JSON.stringify(detail.body)).not.toContain(GUEST_LAST);
    // read-only members cannot fetch bookings or resolve discrepancies
    expect((await c.post(`${conn()}/reservations/poll`)).status).toBe(403);
  });

  it('filters, searches and keeps other tenants out', async () => {
    const cancelled = await owner.get(`/organizations/${orgId}/reservations?propertyId=${propertyId}&view=all&status=CANCELLED`);
    expect(cancelled.body.data.items.every((x: { status: string }) => x.status === 'CANCELLED')).toBe(true);
    const review = await owner.get(`/organizations/${orgId}/reservations?view=all&needsReview=true`);
    expect(review.body.data.items.map((x: { channelReservationId: string }) => x.channelReservationId).sort()).toEqual(['OLD1', 'R2', 'R3']);
    const search = await owner.get(`/organizations/${orgId}/reservations?view=all&q=R3b`);
    expect(search.body.data.items).toHaveLength(1);
    expect((await owner.get(`/organizations/${orgId}/reservations?q=%27%20or%201=1`)).status).toBe(400);

    const other = await h.createUser();
    const oc = h.client();
    await oc.login(other.email, other.password);
    const id = review.body.data.items[0].id;
    expect((await oc.get(`/organizations/${orgId}/reservations/${id}`)).status).toBe(404);
    expect((await oc.get(`/organizations/${other.organizationId}/reservations/${id}`)).status).toBe(404);
    expect((await oc.get(`/organizations/${other.organizationId}/reservations?view=all`)).body.data.total).toBe(0);
  });

  it('gives platform support booking facts only under an owner-approved grant, never guest data', async () => {
    const a = await h.createUser({ platformRole: 'PLATFORM_SUPPORT' });
    const c = h.client();
    await c.login(a.email, a.password);
    const setup = await c.post('/auth/2fa/setup');
    await c.post('/auth/2fa/enable', { code: totpAt(setup.body.data.secret, Date.now()) });
    const req = await c.post('/admin/support-access', { organizationId: orgId, reason: 'Booking R2 is not showing correctly', durationMinutes: 30 });
    const requestId = req.body.data.id;
    expect((await c.get(`/admin/support-access/${requestId}/reservations`)).status).toBe(403);
    expect((await c.get(`/organizations/${orgId}/reservations`)).status).toBe(404);
    await owner.post(`/organizations/${orgId}/support-access/${requestId}/approve`);
    const res = await c.get(`/admin/support-access/${requestId}/reservations`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(GUEST_LAST);
    expect(text).not.toContain(GUEST_EMAIL);
    expect(text).not.toContain('guestEnc');
    expect(text).not.toContain('payloadEnc');
    const audited = await withSystem(h.db, (tx) => tx.auditEvent.findFirst({ where: { organizationId: orgId, action: 'support.data_accessed', entityId: requestId }, orderBy: { createdAt: 'desc' } }));
    expect(audited?.metadata).toMatchObject({ resource: 'reservations' });
  });
});

describe('sync status and failed updates', () => {
  it('opens a discrepancy for an update that cannot be delivered, retries it on request, and resolves it', async () => {
    await runWorker();
    await owner.send('put', `${base()}/calendar`, { from: addDays(today, 90), to: addDays(today, 90), roomTypeIds: [dlxId], availability: { available: 1 } });
    overrides['POST /availability'] = [{ status: 400, body: { status: status(400, 'Invalid room') } }];
    await runWorker();
    const d = await discrepancies('SYNC_FAILED');
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain('could not be sent to Booking.com');

    const st = await owner.get(`/organizations/${orgId}/sync-status?propertyId=${propertyId}`);
    expect(st.status).toBe(200);
    const s = st.body.data.find((x: { connectionId: string }) => x.connectionId === connectionId);
    expect(s).toMatchObject({ health: 'attention', channelName: 'Booking.com', connectionStatus: 'ACTIVE' });
    expect(s.jobs.failed24h).toBeGreaterThanOrEqual(1);
    expect(s.reservations.lastPolledAt).not.toBeNull();
    expect(s.reservations.total).toBeGreaterThan(5);
    const failed = s.recentJobs.find((j: { status: string }) => j.status === 'FAILED');
    expect(failed).toMatchObject({ kind: 'AVAILABILITY', roomTypeName: 'Deluxe Double' });

    const retry = await owner.post(`/organizations/${orgId}/sync-jobs/${failed.id}/retry`);
    expect(retry.status).toBe(200);
    await runWorker();
    expect(await discrepancies('SYNC_FAILED')).toHaveLength(0);
    expect((await owner.post(`/organizations/${orgId}/sync-jobs/${failed.id}/retry`)).status).toBe(200); // still FAILED row → queues again (idempotent target)
    expect((await owner.post(`/organizations/${orgId}/sync-jobs/00000000-0000-7000-8000-000000000000/retry`)).status).toBe(404);
  });

  it('lets the owner resolve, reopen and ignore discrepancies with an audit trail', async () => {
    const [d] = await discrepancies('UNMAPPED_ROOM');
    const r = await owner.post(`/organizations/${orgId}/discrepancies/${d!.id}/resolve`, { note: 'Mapped the room and adjusted availability by hand' });
    expect(r.body.data).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Mapped the room and adjusted availability by hand' });
    expect((await owner.post(`/organizations/${orgId}/discrepancies/${d!.id}/resolve`, {})).status).toBe(409);
    expect((await owner.post(`/organizations/${orgId}/discrepancies/${d!.id}/reopen`, {})).body.data.status).toBe('OPEN');
    expect((await owner.post(`/organizations/${orgId}/discrepancies/${d!.id}/ignore`, {})).body.data.status).toBe('IGNORED');
    expect((await owner.post(`/organizations/${orgId}/discrepancies/${d!.id}/delete`, {})).status).toBe(404);
    const audits = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, entityId: d!.id }, select: { action: true }, orderBy: { createdAt: 'asc' } }));
    expect(audits.map((a) => a.action)).toEqual(['discrepancy.resolved', 'discrepancy.reopened', 'discrepancy.ignored']);
    const all = await owner.get(`/organizations/${orgId}/discrepancies?propertyId=${propertyId}`);
    expect(all.body.data.openBySeverity.high).toBeGreaterThanOrEqual(1);
  });

  it('keeps a room type with bookings from being deleted', async () => {
    const t = (await owner.post(`${base()}/room-types`, { name: 'Garden Cottage', code: 'GDN' })).body.data.id;
    await withSystem(h.db, async (tx) => {
      const r = await tx.reservation.findFirstOrThrow({ where: { connectionId, channelReservationId: 'R2' } });
      await tx.reservationRoom.updateMany({ where: { reservationId: r.id }, data: { roomTypeId: t } });
    });
    expect((await owner.send('delete', `${base()}/room-types/${t}`)).body.error.code).toBe('ROOM_TYPE_HAS_BOOKINGS');
  });
});
