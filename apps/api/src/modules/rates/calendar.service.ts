import type { Tx } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';
import { addDays, currencyDigits, eachDate, fromDbDate, toDbDate, toMinor, weekday } from './dates.js';

/**
 * Units a channel may sell per date for one room type:
 * rooms of the type that are in service, optionally lowered by an owner override, 0 on stop-sell.
 * Overrides above the number of rooms are capped (StaySync never sells rooms that do not exist).
 * Reservations are deducted from Milestone 6 on.
 */
export async function effectiveAvailability(tx: Tx, propertyId: string, roomTypeId: string, from: string, to: string): Promise<Map<string, number>> {
  const [inService, rows] = await Promise.all([
    tx.room.count({ where: { propertyId, roomTypeId, status: 'AVAILABLE' } }),
    tx.inventoryDay.findMany({ where: { roomTypeId, date: { gte: toDbDate(from), lt: toDbDate(to) } } }),
  ]);
  const byDate = new Map(rows.map((r) => [fromDbDate(r.date), r]));
  const out = new Map<string, number>();
  for (const d of eachDate(from, to)) {
    const r = byDate.get(d);
    out.set(d, r?.stopSell ? 0 : r?.available !== null && r?.available !== undefined ? Math.min(r.available, inService) : inService);
  }
  return out;
}

export async function getCalendar(tx: Tx, propertyId: string, from: string, days: number) {
  const to = addDays(from, days);
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true, currency: true, timezone: true } });
  if (!property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
  const [roomTypes, ratePlans, inventory, rates] = await Promise.all([
    tx.roomType.findMany({
      where: { propertyId, status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, maxOccupancy: true, _count: { select: { rooms: { where: { status: 'AVAILABLE' } } } } },
    }),
    tx.ratePlan.findMany({ where: { propertyId, status: 'ACTIVE' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, code: true } }),
    tx.inventoryDay.findMany({ where: { propertyId, date: { gte: toDbDate(from), lt: toDbDate(to) } } }),
    tx.rateDay.findMany({ where: { propertyId, date: { gte: toDbDate(from), lt: toDbDate(to) } } }),
  ]);
  const dates = eachDate(from, to);
  const scale = 10 ** currencyDigits(property.currency);
  const inv = new Map(inventory.map((r) => [`${r.roomTypeId}|${fromDbDate(r.date)}`, r]));
  const rateMap = new Map(rates.map((r) => [`${r.roomTypeId}|${r.ratePlanId}|${fromDbDate(r.date)}`, r]));
  const money = (m: number | null) => (m === null ? null : m / scale);

  return {
    from,
    to,
    dates,
    currency: property.currency,
    timezone: property.timezone,
    ratePlans,
    roomTypes: roomTypes.map((rt) => {
      const inService = rt._count.rooms;
      return {
        id: rt.id,
        name: rt.name,
        code: rt.code,
        maxOccupancy: rt.maxOccupancy,
        roomsInService: inService,
        days: dates.map((d) => {
          const r = inv.get(`${rt.id}|${d}`);
          const override = r?.available ?? null;
          return { date: d, override, stopSell: r?.stopSell ?? false, available: r?.stopSell ? 0 : override !== null ? Math.min(override, inService) : inService };
        }),
        rates: ratePlans.map((rp) => ({
          ratePlanId: rp.id,
          days: dates.map((d) => {
            const r = rateMap.get(`${rt.id}|${rp.id}|${d}`);
            return {
              date: d,
              price: money(r?.priceMinor ?? null),
              priceSingle: money(r?.priceSingleMinor ?? null),
              minStay: r?.minStay ?? null,
              maxStay: r?.maxStay ?? null,
              closed: r?.closed ?? false,
              closedOnArrival: r?.closedOnArrival ?? false,
              closedOnDeparture: r?.closedOnDeparture ?? false,
            };
          }),
        })),
      };
    }),
  };
}

export interface BulkUpdate {
  from: string;
  /** Inclusive (as shown to people). */
  to: string;
  weekdays?: number[];
  roomTypeIds: string[];
  ratePlanIds?: string[];
  availability?: { available?: number | null; stopSell?: boolean };
  rates?: {
    price?: number | null;
    priceSingle?: number | null;
    minStay?: number | null;
    maxStay?: number | null;
    closed?: boolean;
    closedOnArrival?: boolean;
    closedOnDeparture?: boolean;
  };
}

const has = <T extends object>(o: T | undefined, k: keyof T): boolean => !!o && Object.hasOwn(o, k);

/**
 * Applies one bulk edit (date range × weekdays × room types [× rate plans]) with set-based upserts.
 * Only the fields present in the request are changed. Returns the affected range (exclusive end).
 */
export async function applyBulkUpdate(tx: Tx, organizationId: string, propertyId: string, u: BulkUpdate) {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { currency: true } });
  if (!property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
  const toExclusive = addDays(u.to, 1);
  const dates = eachDate(u.from, toExclusive).filter((d) => !u.weekdays || u.weekdays.length === 0 || u.weekdays.includes(weekday(d)));
  if (!dates.length) throw new AppError(400, 'NO_DATES', 'No dates match the selected range and weekdays.');

  const roomTypes = await tx.roomType.findMany({ where: { propertyId, id: { in: u.roomTypeIds } }, select: { id: true } });
  if (roomTypes.length !== new Set(u.roomTypeIds).size) throw new AppError(400, 'UNKNOWN_ROOM_TYPE', 'One or more room types do not belong to this property.');
  const dbDates = dates;
  let changed = 0;

  if (u.availability && (has(u.availability, 'available') || has(u.availability, 'stopSell'))) {
    const setAvail = has(u.availability, 'available');
    const setStop = has(u.availability, 'stopSell');
    const avail = setAvail ? (u.availability.available ?? null) : null;
    const stop = setStop ? !!u.availability.stopSell : false;
    for (const rt of roomTypes) {
      changed += await tx.$executeRaw`
        INSERT INTO inventory_days (organization_id, property_id, room_type_id, date, available, stop_sell, updated_at)
        SELECT ${organizationId}::uuid, ${propertyId}::uuid, ${rt.id}::uuid, d, ${avail}::smallint, ${stop}, now()
        FROM unnest(${dbDates}::date[]) AS d
        ON CONFLICT (room_type_id, date) DO UPDATE SET
          available = CASE WHEN ${setAvail} THEN EXCLUDED.available ELSE inventory_days.available END,
          stop_sell = CASE WHEN ${setStop} THEN EXCLUDED.stop_sell ELSE inventory_days.stop_sell END,
          updated_at = now()`;
    }
  }

  let ratePlanIds: string[] = [];
  const r = u.rates;
  const rateFields = ['price', 'priceSingle', 'minStay', 'maxStay', 'closed', 'closedOnArrival', 'closedOnDeparture'] as const;
  if (r && rateFields.some((f) => has(r, f))) {
    if (!u.ratePlanIds?.length) throw new AppError(400, 'RATE_PLAN_REQUIRED', 'Choose at least one rate plan for price changes.');
    const plans = await tx.ratePlan.findMany({ where: { propertyId, id: { in: u.ratePlanIds } }, select: { id: true } });
    if (plans.length !== new Set(u.ratePlanIds).size) throw new AppError(400, 'UNKNOWN_RATE_PLAN', 'One or more rate plans do not belong to this property.');
    ratePlanIds = plans.map((p) => p.id);
    const cur = property.currency;
    const f = (k: (typeof rateFields)[number]) => has(r, k);
    const price = f('price') && r.price !== null && r.price !== undefined ? toMinor(r.price, cur) : null;
    const priceSingle = f('priceSingle') && r.priceSingle !== null && r.priceSingle !== undefined ? toMinor(r.priceSingle, cur) : null;
    const minStay = f('minStay') ? (r.minStay ?? null) : null;
    const maxStay = f('maxStay') ? (r.maxStay ?? null) : null;
    const closed = f('closed') ? !!r.closed : false;
    const cta = f('closedOnArrival') ? !!r.closedOnArrival : false;
    const ctd = f('closedOnDeparture') ? !!r.closedOnDeparture : false;
    for (const rt of roomTypes) {
      for (const rp of ratePlanIds) {
        changed += await tx.$executeRaw`
          INSERT INTO rate_days (organization_id, property_id, room_type_id, rate_plan_id, date, price_minor, price_single_minor, min_stay, max_stay, closed, closed_on_arrival, closed_on_departure, updated_at)
          SELECT ${organizationId}::uuid, ${propertyId}::uuid, ${rt.id}::uuid, ${rp}::uuid, d, ${price}::int, ${priceSingle}::int, ${minStay}::smallint, ${maxStay}::smallint, ${closed}, ${cta}, ${ctd}, now()
          FROM unnest(${dbDates}::date[]) AS d
          ON CONFLICT (room_type_id, rate_plan_id, date) DO UPDATE SET
            price_minor = CASE WHEN ${f('price')} THEN EXCLUDED.price_minor ELSE rate_days.price_minor END,
            price_single_minor = CASE WHEN ${f('priceSingle')} THEN EXCLUDED.price_single_minor ELSE rate_days.price_single_minor END,
            min_stay = CASE WHEN ${f('minStay')} THEN EXCLUDED.min_stay ELSE rate_days.min_stay END,
            max_stay = CASE WHEN ${f('maxStay')} THEN EXCLUDED.max_stay ELSE rate_days.max_stay END,
            closed = CASE WHEN ${f('closed')} THEN EXCLUDED.closed ELSE rate_days.closed END,
            closed_on_arrival = CASE WHEN ${f('closedOnArrival')} THEN EXCLUDED.closed_on_arrival ELSE rate_days.closed_on_arrival END,
            closed_on_departure = CASE WHEN ${f('closedOnDeparture')} THEN EXCLUDED.closed_on_departure ELSE rate_days.closed_on_departure END,
            updated_at = now()`;
      }
    }
  }

  return {
    dates: dates.length,
    changed,
    dateFrom: dates[0]!,
    dateTo: addDays(dates[dates.length - 1]!, 1),
    roomTypeIds: roomTypes.map((t) => t.id),
    ratePlanIds,
    availabilityChanged: !!u.availability && (has(u.availability, 'available') || has(u.availability, 'stopSell')),
    ratesChanged: ratePlanIds.length > 0,
  };
}
