import type { ChannelPromotion } from '../channel-provider.js';

/**
 * GET /promotions (swagger "promotionsResponse", Booking.com): an XML-to-JSON shape where values sit under
 * "@attributes", e.g. { "@attributes": { id, name, type, active, ... }, stay_date: { "@attributes": { start, end } },
 * discount: { "@attributes": { ... } }, stats: { total_revenue: { "@attributes": { value, currency } }, nr_bookings, ... } }.
 * Only the documented fields are read; unknown or missing values become null (never guessed).
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const attrs = (v: unknown): Obj => (isObj(v) ? (isObj(v['@attributes']) ? v['@attributes'] : v) : {});
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : null);
const int = (v: unknown): number | null => {
  const s = text(v, 12);
  return s && /^\d+$/.test(s) ? Number(s) : null;
};
const flag = (v: unknown): boolean | null => {
  const s = text(v, 10)?.toLowerCase();
  return s === undefined || s === null ? null : ['1', 'true', 'yes'].includes(s) ? true : ['0', 'false', 'no'].includes(s) ? false : null;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

export function parsePromotions(data: unknown): ChannelPromotion[] | null {
  if (!isObj(data)) return null;
  const raw = data['promotions'];
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw['promotion']) ? raw['promotion'] : isObj(raw) ? [raw] : null;
  if (!items) return null;
  const out: ChannelPromotion[] = [];
  for (const it of items.slice(0, 200)) {
    if (!isObj(it)) continue;
    const a = attrs(it);
    const id = text(a['id'], 40);
    if (!id) continue;
    const stay = attrs(it['stay_date']);
    const book = attrs(it['book_date']);
    const discount = attrs(it['discount']);
    const stats = isObj(it['stats']) ? it['stats'] : {};
    const revenue = attrs(stats['total_revenue']);
    const roomsNode = isObj(it['rooms']) ? it['rooms']['room'] : undefined;
    out.push({
      id,
      name: text(a['name']),
      type: text(a['type'], 60),
      active: flag(a['active']),
      nonRefundable: flag(a['non_refundable']),
      minStayThrough: int(a['min_stay_through']),
      discount: text(discount['value'] ?? discount['id'], 20),
      stayFrom: text(stay['start'], 20),
      stayTo: text(stay['end'], 20),
      bookFrom: text(book['start'], 20),
      bookTo: text(book['end'], 20),
      roomIds: list(roomsNode).map((r) => text(attrs(r)['id'], 40)).filter((x): x is string => !!x),
      stats: {
        revenue: text(revenue['value'], 30),
        currency: text(revenue['currency'], 3),
        roomNights: int(stats['nr_room_nights']),
        bookings: int(stats['nr_bookings']),
        cancellations: int(stats['nr_cancellations']),
      },
    });
  }
  return out;
}
