import { describe, expect, it } from 'vitest';
import { Beds24Client } from '../../src/modules/channels/beds24/beds24.client.js';
import { beds24Amount, bookingsToQueue, calendarRangeEvidence, parseBooking, parseRooms, toBeds24Range } from '../../src/modules/channels/beds24/beds24.mappers.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { memoryLogger } from '../helpers.js';

describe('Beds24 mappers', () => {
  it('reads rooms and price slots of the requested property only', () => {
    const body = { success: true, data: [{ id: 5, roomTypes: [{ id: 10, name: 'Double', priceRules: [{ id: 3, name: 'Weekly' }, { id: 3, name: 'dup' }, { id: 17 }] }, { id: 'x' }] }] };
    expect(parseRooms(body, '5')).toEqual([{ id: '10', name: 'Double', rates: [{ id: 'price3', name: 'Weekly', active: null, maxPersons: null }] }]);
    expect(parseRooms(body, '6')).toBeNull();
    expect(parseRooms({ nope: 1 }, '5')).toBeNull();
  });

  it('converts exclusive StaySync ranges by the confirmed rule', () => {
    expect(toBeds24Range('2026-11-01', '2026-11-04', true)).toEqual({ from: '2026-11-01', to: '2026-11-03' });
    expect(toBeds24Range('2026-11-01', '2026-11-04', false)).toEqual({ from: '2026-11-01', to: '2026-11-04' });
  });

  it('finds evidence for the calendar range rule in read-only data', () => {
    const inclusive = { data: [{ roomId: 1, calendar: [{ from: '2026-11-01', to: '2026-11-01', numAvail: 2 }, { from: '2026-11-02', to: '2026-11-05', numAvail: 3 }] }] };
    expect(calendarRangeEvidence(inclusive)).toMatchObject({ inclusive: 2, exclusive: 0 });
    const exclusive = { data: [{ roomId: 1, calendar: [{ from: '2026-11-01', to: '2026-11-03', numAvail: 2 }, { from: '2026-11-03', to: '2026-11-05', numAvail: 3 }] }] };
    expect(calendarRangeEvidence(exclusive)).toMatchObject({ inclusive: 0, exclusive: 1 });
  });

  it('parses a booking, drops card tokens and keeps guest data for encryption only', () => {
    const p = parseBooking({ id: 9, roomId: 10, roomQty: 2, status: 'Confirmed', arrival: '2026-11-01', departure: '2026-11-03', numAdult: 2, numChild: 1, firstName: 'A', lastName: 'B', mobile: '+91', country2: 'in', price: 123.45, stripeToken: 'tok', pcibookingToken: 'pci' });
    expect(p).toMatchObject({ channelReservationId: '9', state: 'NEW', totalPrice: '123.45', guest: { firstName: 'A', phone: '+91', countryCode: 'IN' } });
    expect(p.rooms).toHaveLength(2);
    expect(p.rooms[0]).toMatchObject({ channelRoomId: '10', checkIn: '2026-11-01', checkOut: '2026-11-03', guestCount: 3 });
    expect(JSON.stringify(p.raw)).not.toMatch(/tok|pci/);
    expect(parseBooking({ id: 1, status: 'cancelled' }).state).toBe('CANCELLED');
    expect(parseBooking({ id: 1, status: 'something' }).state).toBeNull();
    expect(beds24Amount(1e21)).toBeNull();
    expect(beds24Amount(-1)).toBeNull();
  });

  it('turns changed bookings into queue entries; new-in-window bookings are listed as new first', () => {
    const since = Date.parse('2026-10-20T10:00:00Z');
    const { queue } = bookingsToQueue(
      [
        { id: 1, status: 'confirmed', bookingTime: '2026-10-20T10:05:00Z', modifiedTime: '2026-10-20T10:05:00Z' },
        { id: 2, status: 'confirmed', bookingTime: '2026-10-20T10:05:00Z', modifiedTime: '2026-10-20T10:20:00Z' },
        { id: 3, status: 'cancelled', bookingTime: '2026-09-01T00:00:00Z', modifiedTime: '2026-10-20T10:30:00Z' },
        { id: 4, status: 'black' },
        { id: 5, status: 'inquiry' },
      ],
      since,
    );
    expect(queue.map((q) => [q.channelReservationId, q.state])).toEqual([
      ['1', 'NEW'],
      ['2', 'NEW'],
      ['2', 'MODIFIED'],
      ['3', 'CANCELLED'],
    ]);
  });
});

describe('Beds24 client', () => {
  const { logger, lines } = memoryLogger('info');
  function client(handler: (url: URL, headers: Record<string, string>) => { status: number; body: unknown; headers?: Record<string, string> }, opts: { allowWrites?: boolean; calendarToInclusive?: boolean | null } = {}) {
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      const u = new URL(url);
      const headers = init.headers as Record<string, string>;
      seen.push({ url: u, headers });
      const r = handler(u, headers);
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } }));
    };
    let now = 1_000_000;
    const c = new Beds24Client({ baseUrl: 'https://b.test/api/v2', refreshToken: 'REFRESH-SECRET', timeoutMs: 1000, logger, fetch: fetchImpl, backoffMs: 0, allowWrites: opts.allowWrites ?? true, calendarToInclusive: opts.calendarToInclusive === undefined ? true : opts.calendarToInclusive, now: () => now });
    return { c, seen, advance: (ms: number) => (now += ms) };
  }

  it('refreshes the access token once, renews it after a 401, and never logs tokens', async () => {
    let issued = 0;
    const { c, seen } = client((u, h) => {
      if (u.pathname.endsWith('/authentication/token')) return { status: 200, body: { token: `ACCESS-${++issued}`, expiresIn: 3600 } };
      if (h['token'] === 'ACCESS-1') return { status: 401, body: { success: false, code: 401, error: 'expired' } };
      return { status: 200, body: { success: true, data: [] } };
    });
    const r = await c.call('properties');
    expect(r.ok).toBe(true);
    expect(issued).toBe(2);
    expect(seen.filter((s) => s.url.pathname.endsWith('/token'))).toHaveLength(2);
    expect(lines.join('\n')).not.toMatch(/REFRESH-SECRET|ACCESS-\d/);
    expect(JSON.stringify(c)).not.toContain('REFRESH');
  });

  it('stops sending when the five-minute credit budget is used up, until it resets', async () => {
    const { c, seen, advance } = client((u) =>
      u.pathname.endsWith('/token') ? { status: 200, body: { token: 'T', expiresIn: 3600 } } : { status: 200, body: { success: true, data: [] }, headers: { 'x-fivemincreditlimit-remaining': '0', 'x-fivemincreditlimit-resetsin': '30' } },
    );
    expect((await c.call('bookings')).ok).toBe(true);
    const before = seen.length;
    const blocked = await c.call('bookings');
    expect(blocked).toMatchObject({ ok: false, outcome: 'RATE_LIMITED' });
    expect(seen.length).toBe(before);
    advance(31_000);
    expect((await c.call('bookings')).ok).toBe(true);
    expect(c.creditStatus()).toMatchObject({ remaining: 0, resetsInSeconds: 30 });
  });

  it('reports { success: false } inside a 2xx reply as a provider error', async () => {
    const { c } = client((u) => (u.pathname.endsWith('/token') ? { status: 200, body: { token: 'T' } } : { status: 200, body: { success: false, code: 1001, error: 'Invalid propertyId' } }));
    expect(await c.call('properties')).toMatchObject({ ok: false, outcome: 'PROVIDER_ERROR', providerCode: 1001, providerMessage: 'Invalid propertyId' });
  });

  it('sends array parameters as repeated keys', async () => {
    const { c, seen } = client((u) => (u.pathname.endsWith('/token') ? { status: 200, body: { token: 'T' } } : { status: 200, body: { success: true, data: [] } }));
    await c.call('bookings', { query: { status: ['confirmed', 'cancelled'], propertyId: 5 } });
    expect(seen.at(-1)!.url.searchParams.getAll('status')).toEqual(['confirmed', 'cancelled']);
  });

  it('refuses writes without the opt-in or before the range rule is confirmed', async () => {
    const off = client(() => ({ status: 200, body: {} }), { allowWrites: false });
    await expect(off.c.call('calendarSet', { body: [] })).rejects.toThrow(/BEDS24_ALLOW_WRITES/);
    const unknown = client(() => ({ status: 200, body: {} }), { calendarToInclusive: null });
    await expect(unknown.c.call('calendarSet', { body: [] })).rejects.toThrow(/BEDS24_CALENDAR_TO_INCLUSIVE/);
    expect(off.seen.length + unknown.seen.length).toBe(0);
  });

  it('refuses non-https base URLs', () => {
    expect(() => new Beds24Client({ baseUrl: 'http://b.test', refreshToken: 'x', timeoutMs: 1000, logger })).toThrow(/https/);
  });
});
