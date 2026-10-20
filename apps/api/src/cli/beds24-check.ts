/**
 * Read-only Beds24 diagnosis. Changes nothing in Beds24.
 *
 *   npm run beds24:check -- <beds24 property id>
 *
 * Shows: whether the token works and its scopes, the property's rooms and price slots (what the StaySync mapping
 * screen will offer), the credit budget, how many upcoming bookings exist (ids and dates only, no guest data),
 * and evidence for BEDS24_CALENDAR_TO_INCLUSIVE from the existing calendar (Beds24's reference does not document it).
 */
import 'dotenv/config';
import pino from 'pino';
import { loadConfig } from '../config/env.js';
import { Beds24Client } from '../modules/channels/beds24/beds24.client.js';
import { calendarRangeEvidence, dataList, parseRooms } from '../modules/channels/beds24/beds24.mappers.js';
import { addDays } from '../modules/rates/dates.js';

const out = (s: string) => process.stdout.write(`${s}\n`);
const pid = process.argv[2]?.trim();
if (!pid || !/^\d{1,12}$/.test(pid)) {
  out('Usage: npm run beds24:check -- <Beds24 property id>   (Beds24: Settings > Properties)');
  process.exit(2);
}
const cfg = loadConfig().beds24;
if (!cfg.refreshToken) {
  out('BEDS24_REFRESH_TOKEN is not set in apps/api/.env. Run npm run beds24:setup first.');
  process.exit(2);
}
const client = new Beds24Client({ baseUrl: cfg.baseUrl, refreshToken: cfg.refreshToken, timeoutMs: cfg.timeoutMs, logger: pino({ level: 'silent' }) });
const fail = (label: string, r: { outcome: string; httpStatus: number | null; error?: { message: string } }) => {
  out(`${label}: ${r.outcome} (HTTP ${r.httpStatus ?? '-'}) ${r.error?.message ?? ''}`);
  process.exit(1);
};

out(`Beds24 API ${cfg.baseUrl} · property ${pid}\n`);
const details = await client.call('authDetails');
if (!details.ok) fail('Token check', details);
const d = details.data as { validToken?: unknown; scopes?: unknown };
out(`Token: ${d.validToken === true ? 'valid' : String(d.validToken)}`);
out(`Scopes: ${Array.isArray(d.scopes) ? d.scopes.join(', ') : 'not reported'}`);

const props = await client.call('properties', { query: { id: pid, includeAllRooms: true, includePriceRules: true } });
if (!props.ok) fail('Property', props);
const rooms = parseRooms(props.data, pid);
if (!rooms) {
  out(`\nProperty ${pid} is not in the account of this token.`);
  process.exit(1);
}
const name = dataList(props.data)?.find((p) => String(p['id']) === pid)?.['name'];
out(`\nProperty: ${typeof name === 'string' ? name : pid} · ${rooms.length} room type(s)`);
for (const r of rooms) out(`  room ${r.id}  ${r.name}  →  ${r.rates.map((x) => `${x.id} (${x.name})`).join(', ')}`);

const today = new Date().toISOString().slice(0, 10);
const cal = await client.call('calendarGet', { query: { startDate: today, endDate: addDays(today, 180), propertyId: pid, includeNumAvail: true, includePrices: true, includeMinStay: true } });
if (!cal.ok) fail('Calendar', cal);
const ev = calendarRangeEvidence(cal.data);
out(`\nCalendar ranges read: ${ev.ranges} · evidence "to is included": ${ev.inclusive} · "to is excluded": ${ev.exclusive}`);
if (ev.inclusive > 0 && ev.exclusive === 0) out('→ Set BEDS24_CALENDAR_TO_INCLUSIVE=true');
else if (ev.exclusive > 0 && ev.inclusive === 0) out('→ Set BEDS24_CALENDAR_TO_INCLUSIVE=false');
else {
  out('→ Not enough evidence yet. In the Beds24 calendar, give ONE single night a different number of rooms');
  out('  available than the nights around it (for a room you are not selling yet), then run this check again.');
}

const bookings = await client.call('bookings', { query: { propertyId: pid } });
if (bookings.ok) {
  const list = dataList(bookings.data) ?? [];
  out(`\nUpcoming bookings (first page): ${list.length}`);
  for (const b of list.slice(0, 5)) out(`  booking ${String(b['id'])}  room ${String(b['roomId'])}  ${String(b['arrival'])} → ${String(b['departure'])}  ${String(b['status'])}`);
  if (list.length) out('  Compare one with Beds24: the second date must be the check-out day.');
} else {
  out(`\nBookings: ${bookings.outcome} ${bookings.error?.message ?? ''} (the token may lack the read:bookings scope)`);
}
const credits = client.creditStatus();
if (credits) out(`\nCredits: ${credits.remaining ?? '?'} of ${credits.limit ?? '?'} left in this five-minute window`);
out(`\nWrites: BEDS24_ALLOW_WRITES=${cfg.allowWrites} · BEDS24_CALENDAR_TO_INCLUSIVE=${cfg.calendarToInclusive ?? '(not set)'}`);
