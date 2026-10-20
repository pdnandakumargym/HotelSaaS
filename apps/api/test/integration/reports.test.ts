import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { addDays, toDbDate, todayIn } from '../../src/modules/rates/dates.js';
import { csvCell } from '../../src/modules/reports/report.service.js';
import { createHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let dlx: string;
let fam: string;
let from: string;

async function addReservation(o: { id: string; status?: 'CONFIRMED' | 'CANCELLED'; env?: string; currency?: string; rooms: { roomTypeId: string | null; checkIn: string; checkOut: string; totalMinor: number | null }[]; connectionId: string; channel?: string; totalMinor?: number | null }) {
  await withSystem(h.db, async (tx) => {
    const r = await tx.reservation.create({
      data: {
        organizationId: orgId,
        propertyId,
        connectionId: o.connectionId,
        provider: 'zodomus',
        environment: o.env ?? 'production',
        channelId: 1,
        channelName: o.channel ?? 'Booking.com',
        channelReservationId: o.id,
        status: o.status ?? 'CONFIRMED',
        checkIn: toDbDate(o.rooms[0]!.checkIn),
        checkOut: toDbDate(o.rooms[0]!.checkOut),
        currency: o.currency ?? 'INR',
        totalMinor: o.totalMinor ?? null,
        roomCount: o.rooms.length,
        source: 'QUEUE',
        cancelledAt: o.status === 'CANCELLED' ? new Date() : null,
      },
    });
    await tx.reservationRoom.createMany({
      data: o.rooms.map((x) => ({ organizationId: orgId, reservationId: r.id, propertyId, roomTypeId: x.roomTypeId, checkIn: toDbDate(x.checkIn), checkOut: toDbDate(x.checkOut), totalMinor: x.totalMinor, occupiesInventory: o.status !== 'CANCELLED' && !!x.roomTypeId })),
    });
  });
}

beforeAll(async () => {
  h = await createHarness();
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  propertyId = (await owner.post(`/organizations/${orgId}/properties`, { name: 'Report Inn', propertyType: 'HOTEL', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' })).body.data.id;
  const base = `/organizations/${orgId}/properties/${propertyId}`;
  dlx = (await owner.post(`${base}/room-types`, { name: 'Deluxe', code: 'DLX' })).body.data.id;
  await owner.post(`${base}/rooms/bulk`, { roomTypeId: dlx, names: ['101', '102'] });
  fam = (await owner.post(`${base}/room-types`, { name: 'Family', code: 'FAM' })).body.data.id;
  await owner.post(`${base}/rooms`, { roomTypeId: fam, name: '201' });
  from = addDays(todayIn('Asia/Kolkata'), 10);
  const conn = await withSystem(h.db, (tx) =>
    tx.channelConnection.create({ data: { organizationId: orgId, propertyId, environment: 'production', channelId: 1, channelName: 'Booking.com', channelPropertyId: `R${Date.now()}`, priceModelId: 1, currency: 'INR', status: 'ACTIVE' } }),
  );
  // 2 nights Deluxe, ₹9,000 → ₹4,500/night
  await addReservation({ id: 'A', connectionId: conn.id, rooms: [{ roomTypeId: dlx, checkIn: from, checkOut: addDays(from, 2), totalMinor: 900000 }] });
  // 1 night Family, room total unknown → booking total used
  await addReservation({ id: 'B', connectionId: conn.id, totalMinor: 600000, rooms: [{ roomTypeId: fam, checkIn: addDays(from, 1), checkOut: addDays(from, 2), totalMinor: null }] });
  // stay starting before the range: only nights inside count
  await addReservation({ id: 'C', connectionId: conn.id, rooms: [{ roomTypeId: dlx, checkIn: addDays(from, -1), checkOut: addDays(from, 1), totalMinor: 800000 }] });
  // excluded: cancelled, other currency; test booking excluded when asked
  await addReservation({ id: 'X', status: 'CANCELLED', connectionId: conn.id, rooms: [{ roomTypeId: dlx, checkIn: from, checkOut: addDays(from, 1), totalMinor: 999900 }] });
  await addReservation({ id: 'Y', currency: 'EUR', connectionId: conn.id, rooms: [{ roomTypeId: dlx, checkIn: addDays(from, 2), checkOut: addDays(from, 3), totalMinor: 10000 }] });
  await addReservation({ id: 'T', env: 'sandbox', connectionId: conn.id, rooms: [{ roomTypeId: fam, checkIn: addDays(from, 2), checkOut: addDays(from, 3), totalMinor: 300000 }] });
});
afterAll(async () => {
  await h.close();
});

describe('reports', () => {
  it('computes occupancy, revenue, ADR and RevPAR from stay nights', async () => {
    const res = await owner.get(`/organizations/${orgId}/reports/summary?propertyId=${propertyId}&from=${from}&to=${addDays(from, 2)}&includeTest=false`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    // 3 rooms × 3 nights = 9; sold: A 2 + B 1 + C 1 = 4 (Y is in EUR and excluded, X is cancelled)
    expect(d.totals).toMatchObject({ roomsInService: 3, roomNightsAvailable: 9, roomNightsSold: 4, revenue: 19000, adr: 4750, occupancyPct: 44.4 });
    expect(d.totals.revpar).toBeCloseTo(2111.11, 1);
    expect(d.totals).toMatchObject({ bookingsStaying: 4, cancellationsStaying: 1 });
    expect(d.otherCurrencyBookings).toBe(1);
    expect(d.daily.map((x: { roomNightsSold: number }) => x.roomNightsSold)).toEqual([2, 2, 0]);
    expect(d.daily[0].revenue).toBe(8500);
    const deluxe = d.byRoomType.find((t: { name: string }) => t.name === 'Deluxe');
    expect(deluxe).toMatchObject({ roomNightsSold: 3, revenue: 13000, occupancyPct: 50 });
    expect(d.byChannel).toEqual([{ channel: 'Booking.com', bookings: 4, cancellations: 1, roomNights: 4, revenue: 19000, sharePct: 100 }]);
  });

  it('includes sandbox test bookings when asked and reports how many', async () => {
    const d = (await owner.get(`/organizations/${orgId}/reports/summary?propertyId=${propertyId}&from=${from}&to=${addDays(from, 2)}`)).body.data;
    expect(d.testBookingsInRange).toBe(1);
    expect(d.totals.roomNightsSold).toBe(5);
    expect(d.totals.revenue).toBe(22000);
  });

  it('exports CSV and neutralises formula-looking text', async () => {
    const res = await owner.get(`/organizations/${orgId}/reports/summary.csv?propertyId=${propertyId}&from=${from}&to=${addDays(from, 2)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('"Room nights sold"');
    expect(res.text).toContain('"Deluxe",2,3,50,13000');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('validates ranges and keeps other tenants out', async () => {
    expect((await owner.get(`/organizations/${orgId}/reports/summary?propertyId=${propertyId}&from=${from}&to=${addDays(from, -1)}`)).body.error.code).toBe('BAD_RANGE');
    expect((await owner.get(`/organizations/${orgId}/reports/summary?propertyId=${propertyId}&from=${from}&to=${addDays(from, 400)}`)).body.error.code).toBe('RANGE_TOO_LONG');
    const other = await h.createUser();
    const oc = h.client();
    await oc.login(other.email, other.password);
    expect((await oc.get(`/organizations/${other.organizationId}/reports/summary?propertyId=${propertyId}&from=${from}&to=${from}`)).status).toBe(404);
  });
});

describe('guest data retention', () => {
  it('erases guest personal data of stays that ended before the retention period, keeping booking facts', async () => {
    const conn = await withSystem(h.db, (tx) => tx.channelConnection.findFirstOrThrow({ where: { propertyId } }));
    await addReservation({ id: 'OLDSTAY', connectionId: conn.id, rooms: [{ roomTypeId: dlx, checkIn: '2020-01-01', checkOut: '2020-01-03', totalMinor: 500000 }] });
    await withSystem(h.db, (tx) => tx.reservation.updateMany({ where: { propertyId, channelReservationId: { in: ['OLDSTAY', 'A'] } }, data: { guestEnc: 'v1.x.y.z', payloadEnc: 'v1.x.y.z' } }));
    expect(await h.services.reservations.purgeGuestData(0)).toBe(0);
    expect(await h.services.reservations.purgeGuestData(365)).toBeGreaterThanOrEqual(1);
    const rows = await withSystem(h.db, (tx) => tx.reservation.findMany({ where: { propertyId, channelReservationId: { in: ['OLDSTAY', 'A'] } }, orderBy: { channelReservationId: 'asc' } }));
    expect(rows.map((r) => [r.channelReservationId, r.guestEnc, r.payloadEnc, r.totalMinor])).toEqual([
      ['A', 'v1.x.y.z', 'v1.x.y.z', null],
      ['OLDSTAY', null, null, null],
    ]);
    const audit = await withSystem(h.db, (tx) => tx.auditEvent.findFirst({ where: { action: 'reservation.guest_data_purged' }, orderBy: { createdAt: 'desc' } }));
    expect(audit?.metadata).toMatchObject({ retentionDays: 365 });
  });
});
