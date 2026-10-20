import type { ParsedReservation, ParsedReservationRoom, ReservationQueueItem, ReservationState } from '../channel-provider.js';
import { sanitizePayload } from '../sanitize.js';

/**
 * Parsers for the Zodomus reservation calls (swagger.json, read 16 Oct 2026):
 *
 *   GET /reservations-queue   → { status, reservations: [{ id: string, status: "1=new, 2=modified, 3=cancelled", date: string }] }
 *   GET /reservations         → { status, reservations: [{ reservation, customer, rooms }] }
 *   GET /reservations-summary → same item shape as /reservations
 *
 *   reservation: { id, status, currencyCode, totalPrice, remarks, RUID }               (all strings)
 *   customer:    { firstName, middleName, lastName, address, city, zipCode, countryCode, email, phone, remarks }
 *   rooms (roomR): { id, name, totalPrice, guestName, numberOfGuests, ArrivalDate, departureDate, smoking,
 *                    mealPlan, remarks, addons, cancelPenalties, prices: { price, date, rateId, … }, priceDetails, … }
 *
 * The spec types `rooms` as a single object and `prices` as a single object; the sandbox sends arrays, so both
 * are accepted. The sandbox also sends `reservations` of GET /reservations as a single object, status values as
 * numbers and `arrivalDate` in lower case (all accepted). Date formats are not specified: only values that start with a real YYYY-MM-DD date are used,
 * anything else is reported (never guessed). Card data is never requested here (no /reservations-cc).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 300): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
};
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : []);
/** First present key (case-insensitive fallback: the spec spells "ArrivalDate" with a capital A). */
function field(o: Obj, ...names: string[]): unknown {
  for (const n of names) if (Object.hasOwn(o, n)) return o[n];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined) return o[k];
  }
  return undefined;
}

/** Queue / reservation status → state. "1"/"2"/"3" are documented; the words are accepted as well. */
export function parseReservationState(v: unknown): ReservationState | null {
  const s = text(v, 40)?.toLowerCase();
  if (!s) return null;
  if (s === '1' || s === 'new' || s === 'confirmed' || s === 'booked') return 'NEW';
  if (s === '2' || s === 'modified' || s === 'modification' || s === 'changed') return 'MODIFIED';
  if (s === '3' || s === 'cancelled' || s === 'canceled' || s === 'cancellation') return 'CANCELLED';
  return null;
}

/** Accepts "YYYY-MM-DD", optionally followed by a time ("2026-10-20 14:00:00", "2026-10-20T14:00"). */
export function parseChannelDate(v: unknown): string | null {
  const s = text(v, 40);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ]\d{2}:\d{2})/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "260.00" → "260.00"; rejects anything that is not a plain non-negative decimal. */
export function parseAmount(v: unknown): string | null {
  const s = text(v, 30);
  return s && /^\d{1,10}(\.\d{1,4})?$/.test(s) ? s : null;
}

const count = (v: unknown): number | null => {
  const s = text(v, 10);
  return s && /^\d{1,3}$/.test(s) ? Number(s) : null;
};

export function parseReservationQueue(data: unknown): ReservationQueueItem[] | null {
  if (!isObj(data)) return null;
  const items = data['reservations'];
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) return null;
  const out: ReservationQueueItem[] = [];
  for (const it of items.slice(0, 500)) {
    if (!isObj(it)) continue;
    const id = text(it['id'], 64);
    if (!id) continue;
    out.push({ channelReservationId: id, state: parseReservationState(it['status']), rawStatus: text(it['status'], 40), changedAt: text(it['date'], 40) });
  }
  return out;
}

function parseRoom(r: Obj): ParsedReservationRoom {
  const prices = list(field(r, 'prices'));
  const rateId = prices.map((p) => text(field(p, 'rateId'), 40)).find((x) => x !== null) ?? null;
  const arrivalRaw = field(r, 'ArrivalDate', 'arrivalDate', 'arrival');
  const departureRaw = field(r, 'departureDate', 'DepartureDate', 'departure');
  return {
    channelRoomId: text(field(r, 'id', 'roomId'), 40),
    name: text(field(r, 'name', 'roomName'), 200),
    channelRateId: rateId,
    checkIn: parseChannelDate(arrivalRaw),
    checkOut: parseChannelDate(departureRaw),
    datesPresent: text(arrivalRaw, 40) !== null && text(departureRaw, 40) !== null,
    guestCount: count(field(r, 'numberOfGuests')),
    totalPrice: parseAmount(field(r, 'totalPrice')),
    mealPlan: text(field(r, 'mealPlan'), 200),
    guestName: text(field(r, 'guestName'), 200),
    remarks: text(field(r, 'remarks'), 1000),
  };
}

/** Parses GET /reservations and GET /reservations-summary. Returns null when the envelope is not the documented one. */
export function parseReservations(data: unknown): ParsedReservation[] | null {
  if (!isObj(data)) return null;
  const raw = data['reservations'];
  if (raw === undefined || raw === null) return [];
  // Sandbox (19 Oct 2026): GET /reservations returns ONE object here, /reservations-summary an array.
  let items: unknown[];
  if (Array.isArray(raw)) items = raw;
  else if (isObj(raw) && (isObj(raw['reservation']) || 'rooms' in raw)) items = [raw];
  else return null;
  const out: ParsedReservation[] = [];
  for (const it of items.slice(0, 500)) {
    if (!isObj(it)) continue;
    const res = isObj(it['reservation']) ? it['reservation'] : {};
    const cust = isObj(it['customer']) ? it['customer'] : {};
    const currency = text(field(res, 'currencyCode'), 3)?.toUpperCase() ?? null;
    out.push({
      channelReservationId: text(field(res, 'id'), 64),
      state: parseReservationState(field(res, 'status')),
      rawStatus: text(field(res, 'status'), 40),
      currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
      totalPrice: parseAmount(field(res, 'totalPrice')),
      remarks: text(field(res, 'remarks'), 2000),
      guest: {
        firstName: text(cust['firstName'], 120),
        middleName: text(cust['middleName'], 120),
        lastName: text(cust['lastName'], 120),
        email: text(cust['email'], 254),
        phone: text(cust['phone'], 40),
        address: text(cust['address'], 300),
        city: text(cust['city'], 120),
        zipCode: text(cust['zipCode'], 20),
        countryCode: text(cust['countryCode'], 3)?.toUpperCase() ?? null,
        remarks: text(cust['remarks'], 1000),
      },
      rooms: list(it['rooms']).slice(0, 100).map(parseRoom),
      // Kept (encrypted) because a reservation can be retrieved only once. Card-like keys are dropped.
      raw: sanitizePayload(it),
    });
  }
  return out;
}
