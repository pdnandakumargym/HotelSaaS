import type { ChannelRoom, ParsedGuest, ParsedReservation, ParsedReservationRoom, ReservationQueueItem, ReservationState } from '../channel-provider.js';
import { sanitizePayload } from '../sanitize.js';
import { parseAmount, parseChannelDate } from '../zodomus/zodomus.reservations.js';
import { addDays } from '../../rates/dates.js';

/**
 * Parsers for Beds24 API v2 responses (apiV2.yaml, read 20 Oct 2026):
 *
 *   GET /properties  → { success, type: "property", count, pages: { nextPageExists, nextPageLink }, data: [property] }
 *       property.roomTypes[]: { id, propertyId, name, qty, …, priceRules[]: { id 1..16, name, … } }
 *   GET /bookings    → { success, type: "booking", count, pages, data: [booking] }
 *       booking: { id, propertyId, roomId, unitId, roomQty, status (confirmed|request|new|cancelled|black|inquiry),
 *                  arrival, departure (date), numAdult, numChild, firstName, lastName, email, phone, mobile, address,
 *                  city, postcode, country, country2, comments, price, channel, apiReference, bookingTime,
 *                  modifiedTime, cancelTime (date-time), stripeToken, pcibookingToken, … }
 *   GET /inventory/rooms/calendar → { success, data: [{ roomId, propertyId, calendar: [{ from, to, numAvail, … }] }] }
 *
 * Card-related booking fields (stripeToken, pcibookingToken) are never read and are removed before anything is stored.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 300): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
};
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const nonNegInt = (v: unknown, max = 999): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/** Price slots of the Beds24 calendar (price1 … price16). */
export const PRICE_SLOT_RE = /^price([1-9]|1[0-6])$/;

/** Beds24 numbers (prices are JSON doubles) → decimal string, never in exponent notation. */
export function beds24Amount(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return parseAmount(String(Number(v.toFixed(4))));
  return parseAmount(v);
}

/** `data` array of a documented list response, or null when the shape is not the documented one. */
export function dataList(body: unknown): Obj[] | null {
  if (!isObj(body) || !Array.isArray(body['data'])) return null;
  return body['data'].filter(isObj);
}

export function nextPageExists(body: unknown): boolean {
  return isObj(body) && isObj(body['pages']) && body['pages']['nextPageExists'] === true;
}

/**
 * Rooms of one property and the price slots that can be mapped to StaySync rate plans.
 * A room with price rules offers those slots (named as in Beds24); a room without any offers price1, the
 * calendar's default price field. Returns null when the property is not in the response.
 */
export function parseRooms(body: unknown, propertyId: string): ChannelRoom[] | null {
  const props = dataList(body);
  if (!props) return null;
  const prop = props.find((p) => text(p['id']) === propertyId);
  if (!prop) return null;
  const rooms = Array.isArray(prop['roomTypes']) ? prop['roomTypes'].filter(isObj) : [];
  const out: ChannelRoom[] = [];
  for (const r of rooms) {
    const id = posInt(r['id']);
    if (!id) continue;
    const rules = Array.isArray(r['priceRules']) ? r['priceRules'].filter(isObj) : [];
    const rates = rules
      .map((rule) => ({ slot: posInt(rule['id']), name: text(rule['name'], 80) }))
      .filter((x): x is { slot: number; name: string | null } => x.slot !== null && x.slot <= 16)
      .map((x) => ({ id: `price${x.slot}`, name: x.name ?? `Price ${x.slot}`, active: null, maxPersons: null }));
    const unique = rates.filter((x, i) => rates.findIndex((y) => y.id === x.id) === i);
    out.push({
      id: String(id),
      name: text(r['name'], 120) ?? `Room ${id}`,
      rates: unique.length ? unique : [{ id: 'price1', name: 'Price 1 (calendar default price)', active: null, maxPersons: null }],
    });
  }
  return out;
}

/** Inclusive Beds24 range for a StaySync range [dateFrom, dateTo) according to the confirmed rule. */
export function toBeds24Range(dateFrom: string, dateToExclusive: string, toInclusive: boolean): { from: string; to: string } {
  return { from: dateFrom, to: toInclusive ? addDays(dateToExclusive, -1) : dateToExclusive };
}

/**
 * Evidence about whether Beds24 treats the calendar `to` date as included, from a read-only calendar response.
 * Beds24 groups equal consecutive days into ranges. A range whose `from` equals its `to` can only mean
 * "to is included" (an exclusive end would make it empty). Ranges that touch (next.from === prev.to) mean
 * "to is excluded"; ranges that follow on the next day (next.from === prev.to + 1) mean "to is included".
 */
export function calendarRangeEvidence(body: unknown): { inclusive: number; exclusive: number; ranges: number } {
  const ev = { inclusive: 0, exclusive: 0, ranges: 0 };
  for (const room of dataList(body) ?? []) {
    const cal = Array.isArray(room['calendar']) ? room['calendar'].filter(isObj) : [];
    let prevTo: string | null = null;
    for (const e of cal) {
      const from = parseChannelDate(e['from']);
      const to = parseChannelDate(e['to']);
      if (!from || !to) {
        prevTo = null;
        continue;
      }
      ev.ranges++;
      if (from === to) ev.inclusive++;
      if (prevTo) {
        if (from === prevTo) ev.exclusive++;
        else if (from === addDays(prevTo, 1)) ev.inclusive++;
      }
      prevTo = to;
    }
  }
  return ev;
}

const STATES: Record<string, ReservationState> = { confirmed: 'NEW', new: 'NEW', request: 'NEW', cancelled: 'CANCELLED' };
/** Booking statuses StaySync imports. "black" (owner block) and "inquiry" (no booking) are not reservations. */
export const IMPORTED_STATUSES = ['confirmed', 'request', 'new', 'cancelled'] as const;

function guestOf(b: Obj): ParsedGuest {
  return {
    firstName: text(b['firstName'], 100),
    middleName: null,
    lastName: text(b['lastName'], 100),
    email: text(b['email'], 200),
    phone: text(b['phone'], 50) ?? text(b['mobile'], 50),
    address: text(b['address'], 200),
    city: text(b['city'], 100),
    zipCode: text(b['postcode'], 20),
    countryCode: text(b['country2'], 2)?.toUpperCase() ?? null,
    remarks: text(b['comments'], 2000),
  };
}

/** One Beds24 booking → the provider-neutral reservation. Each booked unit (roomQty) is one room line. */
export function parseBooking(b: Obj): ParsedReservation {
  const status = text(b['status'], 30)?.toLowerCase() ?? null;
  const guest = guestOf(b);
  const qty = Math.min(Math.max(posInt(b['roomQty']) ?? 1, 1), 20);
  const arrivalRaw = b['arrival'];
  const departureRaw = b['departure'];
  const guests = (nonNegInt(b['numAdult']) ?? 0) + (nonNegInt(b['numChild']) ?? 0);
  const roomId = posInt(b['roomId']);
  const name = [guest.firstName, guest.lastName].filter(Boolean).join(' ') || null;
  const room: ParsedReservationRoom = {
    channelRoomId: roomId ? String(roomId) : null,
    name: null,
    // Beds24 does not say which price slot a booking used.
    channelRateId: null,
    checkIn: parseChannelDate(arrivalRaw),
    checkOut: parseChannelDate(departureRaw),
    datesPresent: arrivalRaw !== undefined && arrivalRaw !== null && departureRaw !== undefined && departureRaw !== null,
    guestCount: guests > 0 ? guests : null,
    totalPrice: null,
    mealPlan: null,
    guestName: name,
    remarks: null,
  };
  const raw = { ...b };
  delete raw['stripeToken'];
  delete raw['pcibookingToken'];
  delete raw['invoiceItems'];
  return {
    channelReservationId: posInt(b['id']) ? String(posInt(b['id'])) : null,
    state: status ? (STATES[status] ?? null) : null,
    rawStatus: status,
    currency: null,
    totalPrice: beds24Amount(b['price']),
    remarks: null,
    guest,
    rooms: Array.from({ length: qty }, () => ({ ...room })),
    raw: sanitizePayload(raw),
  };
}

const ts = (v: unknown): number | null => {
  const s = text(v, 40);
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
};

/**
 * Bookings changed since `sinceMs` → queue entries in the shape the reservation service expects.
 * A booking created in the window is listed as NEW first (so a later change of a booking StaySync never saw is
 * not reported as unknown); its current state follows when it differs. `changedAt` is Beds24's modifiedTime.
 */
export function bookingsToQueue(bookings: Obj[], sinceMs: number): { queue: ReservationQueueItem[]; parsed: Map<string, ParsedReservation> } {
  const queue: ReservationQueueItem[] = [];
  const parsed = new Map<string, ParsedReservation>();
  for (const b of bookings) {
    const p = parseBooking(b);
    const id = p.channelReservationId;
    if (!id || p.rawStatus === null || !(IMPORTED_STATUSES as readonly string[]).includes(p.rawStatus)) continue;
    const created = ts(b['bookingTime']);
    const modified = ts(b['modifiedTime']);
    const changedAt = text(b['modifiedTime'], 40) ?? text(b['bookingTime'], 40);
    const createdInWindow = created !== null && created >= sinceMs;
    const changedLater = created !== null && modified !== null && modified > created;
    const state: ReservationState | null = p.state === 'CANCELLED' ? 'CANCELLED' : p.state === 'NEW' ? (changedLater ? 'MODIFIED' : 'NEW') : null;
    if (createdInWindow && state !== 'NEW') queue.push({ channelReservationId: id, state: 'NEW', rawStatus: 'created', changedAt: text(b['bookingTime'], 40) });
    queue.push({ channelReservationId: id, state, rawStatus: p.rawStatus, changedAt });
    parsed.set(id, p);
  }
  return { queue, parsed };
}
