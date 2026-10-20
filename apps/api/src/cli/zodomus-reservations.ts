/**
 * Checks the reservation calls against Zodomus (sandbox by default) and prints only:
 * the status envelope, the response STRUCTURE (keys and types, no values) and what StaySync's parser
 * understood (booking number, status, room ids, dates, counts). Guest names, contact details and remarks
 * are never printed. Card data (GET /reservations-cc) is never requested.
 *
 *   npm run zodomus:reservations -- 17446591            # queue + summary + first queued booking
 *   npm run zodomus:reservations -- 17446591 --create new   # sandbox only: create a test booking first
 */
import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { describeShape } from '../modules/channels/sanitize.js';
import { parseReservationQueue, parseReservations } from '../modules/channels/zodomus/zodomus.reservations.js';

const [pid, flag, createStatus] = process.argv.slice(2).map((s) => s.trim());
if (!pid || !/^[A-Za-z0-9_-]{1,40}$/.test(pid) || (flag && (flag !== '--create' || !['new', 'modified', 'cancelled'].includes(createStatus ?? '')))) {
  process.stdout.write('Usage: npm run zodomus:reservations -- <channel property id> [--create new|modified|cancelled]\n');
  process.exit(2);
}
const z = loadConfig().zodomus;
const out = (s: string) => process.stdout.write(`${s}\n`);
if (!z.username || !z.password) {
  out('ZODOMUS_API_USERNAME / ZODOMUS_API_PASSWORD are not set in apps/api/.env');
  process.exit(1);
}
out(`Zodomus ${z.environment} · channelId 1 (Booking.com) · propertyId ${pid}`);

const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await fetch(`${z.baseUrl}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Basic ${Buffer.from(`${z.username}:${z.password}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(z.timeoutMs),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const status = (data as { status?: unknown } | null)?.status ?? null;
  out(`\n${method} ${path.split('?')[0]}: HTTP ${res.status}`);
  out(`status: ${JSON.stringify(status)}`);
  return data;
};

const q = `channelId=1&propertyId=${encodeURIComponent(pid)}`;

if (flag === '--create') {
  if (z.environment !== 'sandbox') {
    out('Refusing to create a test booking outside the sandbox.');
    process.exit(1);
  }
  await call('POST', '/reservations-createtest', { channelId: 1, propertyId: pid, status: createStatus });
}

const queueData = await call('GET', `/reservations-queue?${q}`);
out(`structure: ${JSON.stringify(describeShape(queueData))}`);
const queue = parseReservationQueue(queueData);
out(queue ? `parsed queue: ${JSON.stringify(queue)}` : 'parsed queue: NOT RECOGNISED');

const report = (label: string, data: unknown) => {
  out(`structure: ${JSON.stringify(describeShape(data))}`);
  const items = parseReservations(data);
  if (!items) return out(`${label}: NOT RECOGNISED`);
  out(`${label}: ${items.length} booking(s)`);
  for (const r of items) {
    out(
      `  booking ${r.channelReservationId ?? '?'} · status ${r.rawStatus ?? '?'} (${r.state ?? 'unrecognised'}) · ${r.currency ?? '?'} ${r.totalPrice ?? '?'} · guest data present: ${Object.values(r.guest).some((v) => v !== null) ? 'yes' : 'no'}`,
    );
    for (const room of r.rooms) {
      out(`    room ${room.channelRoomId ?? '?'} · rate ${room.channelRateId ?? '?'} · ${room.checkIn ?? (room.datesPresent ? 'UNRECOGNISED DATE' : 'no date')} → ${room.checkOut ?? (room.datesPresent ? 'UNRECOGNISED DATE' : 'no date')} · guests ${room.guestCount ?? '?'} · total ${room.totalPrice ?? '?'}`);
    }
  }
};

report('parsed summary', await call('GET', `/reservations-summary?${q}`));
const first = queue?.[0];
if (first) report(`parsed booking ${first.channelReservationId}`, await call('GET', `/reservations?${q}&reservationId=${encodeURIComponent(first.channelReservationId)}`));
else out('\nThe queue is empty, so no booking was retrieved. Use --create new to make a test booking (sandbox).');
