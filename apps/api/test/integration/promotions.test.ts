import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { createHarness, type Client, type Harness } from './harness.js';

const ENV = { ZODOMUS_ENABLED: 'true', ZODOMUS_API_USERNAME: 'fake-user-promo', ZODOMUS_API_PASSWORD: 'fake-pass-promo', ZODOMUS_BASE_URL: 'https://zodomus.fake.test' };
const OK = { status: { returnCode: 200, returnMessage: 'OK' } };
const PROMOS = {
  ...OK,
  promotions: [
    {
      '@attributes': { id: '5551', name: 'Early summer', type: 'basic', target_channel: 'public', min_stay_through: '2', non_refundable: '1', no_cc_promotion: '0', active: '1' },
      book_date: { '@attributes': { start: '2026-10-01', end: '2026-12-31' } },
      stay_date: { '@attributes': { start: '2027-04-01', end: '2027-06-30' }, active_weekdays: { active_weekday: ['Mon', 'Tue'] } },
      rooms: { room: [{ '@attributes': { id: '1744659101' } }, { '@attributes': { id: '1744659102' } }] },
      discount: { '@attributes': { value: '15' } },
      stats: { total_revenue: { '@attributes': { value: '1200.00', currency: 'INR' } }, nr_room_nights: '4', nr_bookings: '2', nr_cancellations: '0' },
    },
  ],
};
const seen: { method: string; path: string; query: Record<string, string> }[] = [];
let failNext = false;
const fakeFetch: FetchLike = (url, init) => {
  const u = new URL(url);
  seen.push({ method: init.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams) });
  const body = failNext ? { status: { returnCode: 400, returnMessage: 'Promotion not found' } } : u.pathname === '/promotions' ? PROMOS : OK;
  failNext = false;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
};

let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let connectionId: string;
const url = () => `/organizations/${orgId}/properties/${propertyId}/channel-connections/${connectionId}/promotions`;

beforeAll(async () => {
  h = await createHarness(ENV, { channelFetch: fakeFetch });
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  propertyId = (await owner.post(`/organizations/${orgId}/properties`, { name: 'Promo Stay', propertyType: 'HOTEL', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' })).body.data.id;
  connectionId = (
    await withSystem(h.db, (tx) =>
      tx.channelConnection.create({ data: { organizationId: orgId, propertyId, environment: 'sandbox', channelId: 1, channelName: 'Booking.com', channelPropertyId: `P${Date.now()}`, priceModelId: 1, currency: 'INR', status: 'ACTIVE' } }),
    )
  ).id;
});
afterAll(async () => {
  await h.close();
});

describe('promotions', () => {
  it('lists Booking.com promotions with their stats', async () => {
    const res = await owner.get(`${url()}?active=1`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: '5551',
        name: 'Early summer',
        type: 'basic',
        active: true,
        nonRefundable: true,
        minStayThrough: 2,
        discount: '15',
        stayFrom: '2027-04-01',
        stayTo: '2027-06-30',
        bookFrom: '2026-10-01',
        bookTo: '2026-12-31',
        roomIds: ['1744659101', '1744659102'],
        stats: { revenue: '1200.00', currency: 'INR', roomNights: 4, bookings: 2, cancellations: 0 },
      },
    ]);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', path: '/promotions', query: { channelId: '1', active: '1' } });
  });

  it('activates and deactivates with the documented query parameters, audited', async () => {
    expect((await owner.post(`${url()}/5551/deactivate`)).body.data).toEqual({ promotionId: '5551', active: false });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', path: '/deactivate-promotion', query: { channelId: '1', promotionId: '5551' } });
    expect((await owner.post(`${url()}/5551/activate`)).status).toBe(200);
    expect(seen.at(-1)?.path).toBe('/activate-promotion');
    failNext = true;
    const bad = await owner.post(`${url()}/9999/activate`);
    expect(bad.status).toBe(502);
    expect(bad.body.error.message).toContain('Promotion not found');
    expect((await owner.post(`${url()}/5551/delete`)).status).toBe(404);
    expect((await owner.post(`${url()}/bad%20id/activate`)).status).toBe(404);
    const audits = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, action: { startsWith: 'promotion.' } }, select: { action: true } }));
    expect(audits.map((a) => a.action).sort()).toEqual(['promotion.activated', 'promotion.activated', 'promotion.deactivated']);
  });

  it('requires channel.manage to change, and an active connection', async () => {
    const ro = await h.createUser({ role: 'READ_ONLY', organizationId: orgId });
    const c = h.client();
    await c.login(ro.email, ro.password);
    expect((await c.get(url())).status).toBe(200);
    expect((await c.post(`${url()}/5551/deactivate`)).status).toBe(403);
    await withSystem(h.db, (tx) => tx.channelConnection.update({ where: { id: connectionId }, data: { status: 'ACTIVATED' } }));
    expect((await owner.get(url())).body.error.code).toBe('CONNECTION_NOT_ACTIVE');
  });
});
