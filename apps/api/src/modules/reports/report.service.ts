import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';
import { addDays, currencyDigits, daysBetween, eachDate, fromDbDate, toDbDate } from '../rates/dates.js';

export interface ReportQuery {
  propertyId: string;
  /** Inclusive, property-local dates. */
  from: string;
  to: string;
  includeTest: boolean;
}

interface NightRow {
  night: Date;
  room_type_id: string | null;
  channel_name: string;
  nights: number;
  occupied: number;
  revenue_minor: string | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Stay-date reports from stored reservations (no provider calls).
 * - Room nights available = rooms in service today × nights (StaySync keeps no history of rooms in service).
 * - Room nights sold = nights of non-cancelled reservation rooms that occupy inventory (mapped, valid dates).
 * - Revenue = each room's total spread evenly over its nights; only bookings in the property currency count.
 */
export class ReportService {
  constructor(private readonly db: Database) {}

  summary(organizationId: string, q: ReportQuery) {
    if (q.to < q.from) throw new AppError(400, 'BAD_RANGE', 'The end date must be on or after the start date.');
    if (daysBetween(q.from, q.to) > 366) throw new AppError(400, 'RANGE_TOO_LONG', 'Choose at most 367 days.');
    const toExclusive = addDays(q.to, 1);
    return withTenant(this.db, organizationId, async (tx) => {
      const property = await tx.property.findUnique({ where: { id: q.propertyId }, select: { id: true, name: true, currency: true, timezone: true } });
      if (!property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      const envs = q.includeTest ? ['sandbox', 'production'] : ['production'];
      const [roomTypes, rows, bookings, received, cancelled, otherCurrency, testCount] = await Promise.all([
        tx.roomType.findMany({ where: { propertyId: q.propertyId }, select: { id: true, name: true, status: true, _count: { select: { rooms: { where: { status: 'AVAILABLE' } } } } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        tx.$queryRaw<NightRow[]>`
          SELECT g.d::date AS night, rr.room_type_id::text AS room_type_id, r.channel_name,
                 count(*)::int AS nights,
                 count(*) FILTER (WHERE rr.occupies_inventory)::int AS occupied,
                 sum(COALESCE(rr.total_minor::numeric, r.total_minor::numeric / NULLIF(r.room_count, 0)) / (rr.check_out - rr.check_in))::text AS revenue_minor
          FROM reservation_rooms rr
          JOIN reservations r ON r.id = rr.reservation_id
          JOIN generate_series(${toDbDate(q.from)}::date, ${toDbDate(toExclusive)}::date - 1, interval '1 day') AS g(d)
            ON rr.check_in <= g.d::date AND rr.check_out > g.d::date
          WHERE rr.property_id = ${q.propertyId}::uuid AND r.status <> 'CANCELLED'
            AND rr.check_in IS NOT NULL AND rr.check_out IS NOT NULL
            AND (r.currency IS NULL OR r.currency = ${property.currency})
            AND r.environment = ANY(${envs}::text[])
          GROUP BY 1, 2, 3`,
        tx.reservation.groupBy({
          by: ['channelName', 'status'],
          where: { propertyId: q.propertyId, environment: { in: envs }, checkIn: { lt: toDbDate(toExclusive) }, checkOut: { gt: toDbDate(q.from) } },
          _count: { _all: true },
        }),
        tx.reservation.count({ where: { propertyId: q.propertyId, environment: { in: envs }, receivedAt: { gte: toDbDate(q.from), lt: toDbDate(toExclusive) } } }),
        tx.reservation.count({ where: { propertyId: q.propertyId, environment: { in: envs }, cancelledAt: { gte: toDbDate(q.from), lt: toDbDate(toExclusive) } } }),
        tx.reservation.count({ where: { propertyId: q.propertyId, environment: { in: envs }, currency: { not: property.currency }, checkIn: { lt: toDbDate(toExclusive) }, checkOut: { gt: toDbDate(q.from) } } }),
        tx.reservation.count({ where: { propertyId: q.propertyId, environment: 'sandbox', checkIn: { lt: toDbDate(toExclusive) }, checkOut: { gt: toDbDate(q.from) } } }),
      ]);

      const scale = 10 ** currencyDigits(property.currency);
      const money = (minor: number) => Math.round(minor) / scale;
      const dates = eachDate(q.from, toExclusive);
      const inService = roomTypes.reduce((n, t) => n + t._count.rooms, 0);
      const available = inService * dates.length;

      const daily = new Map(dates.map((d) => [d, { date: d, sold: 0, revenueMinor: 0 }]));
      const byType = new Map<string, { sold: number; revenueMinor: number }>();
      const byChannel = new Map<string, { roomNights: number; revenueMinor: number }>();
      let sold = 0;
      let revenueNights = 0;
      let revenueMinor = 0;
      for (const r of rows) {
        const rev = r.revenue_minor ? Number(r.revenue_minor) : 0;
        const day = daily.get(fromDbDate(r.night));
        if (day) {
          day.sold += r.occupied;
          day.revenueMinor += rev;
        }
        sold += r.occupied;
        revenueNights += r.nights;
        revenueMinor += rev;
        const tKey = r.room_type_id ?? 'unmapped';
        const t = byType.get(tKey) ?? { sold: 0, revenueMinor: 0 };
        t.sold += r.room_type_id ? r.occupied : r.nights;
        t.revenueMinor += rev;
        byType.set(tKey, t);
        const c = byChannel.get(r.channel_name) ?? { roomNights: 0, revenueMinor: 0 };
        c.roomNights += r.nights;
        c.revenueMinor += rev;
        byChannel.set(r.channel_name, c);
      }
      const channels = new Set([...byChannel.keys(), ...bookings.map((b) => b.channelName)]);

      return {
        property: { id: property.id, name: property.name, currency: property.currency, timezone: property.timezone },
        from: q.from,
        to: q.to,
        nights: dates.length,
        includeTest: q.includeTest,
        testBookingsInRange: testCount,
        otherCurrencyBookings: otherCurrency,
        totals: {
          roomsInService: inService,
          roomNightsAvailable: available,
          roomNightsSold: sold,
          occupancyPct: available ? round1((sold / available) * 100) : null,
          revenue: money(revenueMinor),
          adr: revenueNights ? money(revenueMinor / revenueNights) : null,
          revpar: available ? money(revenueMinor / available) : null,
          bookingsStaying: bookings.filter((b) => b.status !== 'CANCELLED').reduce((n, b) => n + b._count._all, 0),
          cancellationsStaying: bookings.filter((b) => b.status === 'CANCELLED').reduce((n, b) => n + b._count._all, 0),
          bookingsReceived: received,
          cancellationsReceived: cancelled,
        },
        daily: [...daily.values()].map((d) => ({ date: d.date, roomNightsSold: d.sold, occupancyPct: inService ? round1((d.sold / inService) * 100) : null, revenue: money(d.revenueMinor) })),
        byRoomType: [
          ...roomTypes.map((t) => {
            const v = byType.get(t.id) ?? { sold: 0, revenueMinor: 0 };
            const cap = t._count.rooms * dates.length;
            return { roomTypeId: t.id, name: t.name, roomsInService: t._count.rooms, roomNightsSold: v.sold, occupancyPct: cap ? round1((v.sold / cap) * 100) : null, revenue: money(v.revenueMinor), adr: v.sold ? money(v.revenueMinor / v.sold) : null };
          }),
          ...(byType.has('unmapped') ? [{ roomTypeId: null, name: 'Unmapped channel rooms', roomsInService: 0, roomNightsSold: byType.get('unmapped')!.sold, occupancyPct: null, revenue: money(byType.get('unmapped')!.revenueMinor), adr: null }] : []),
        ],
        byChannel: [...channels].sort().map((name) => {
          const v = byChannel.get(name) ?? { roomNights: 0, revenueMinor: 0 };
          const b = bookings.filter((x) => x.channelName === name);
          return {
            channel: name,
            bookings: b.filter((x) => x.status !== 'CANCELLED').reduce((n, x) => n + x._count._all, 0),
            cancellations: b.filter((x) => x.status === 'CANCELLED').reduce((n, x) => n + x._count._all, 0),
            roomNights: v.roomNights,
            revenue: money(v.revenueMinor),
            sharePct: revenueMinor ? round1((v.revenueMinor / revenueMinor) * 100) : null,
          };
        }),
      };
    });
  }
}

/** Byte-order mark so spreadsheet apps read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** CSV cell: numbers as-is; text quoted, and formula-looking text neutralised (CSV injection). */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(r: Awaited<ReturnType<ReportService['summary']>>): string {
  const lines = [
    ['Date', 'Room nights sold', 'Occupancy %', `Revenue (${r.property.currency})`].map(csvCell).join(','),
    ...r.daily.map((d) => [csvCell(d.date), csvCell(d.roomNightsSold), csvCell(d.occupancyPct), csvCell(d.revenue)].join(',')),
    '',
    ['Room type', 'Rooms in service', 'Room nights sold', 'Occupancy %', `Revenue (${r.property.currency})`, 'ADR'].map(csvCell).join(','),
    ...r.byRoomType.map((t) => [csvCell(t.name), csvCell(t.roomsInService), csvCell(t.roomNightsSold), csvCell(t.occupancyPct), csvCell(t.revenue), csvCell(t.adr)].join(',')),
    '',
    ['Channel', 'Bookings', 'Cancellations', 'Room nights', `Revenue (${r.property.currency})`, 'Revenue share %'].map(csvCell).join(','),
    ...r.byChannel.map((c) => [csvCell(c.channel), csvCell(c.bookings), csvCell(c.cancellations), csvCell(c.roomNights), csvCell(c.revenue), csvCell(c.sharePct)].join(',')),
  ];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
