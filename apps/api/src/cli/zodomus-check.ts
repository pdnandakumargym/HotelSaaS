/**
 * Diagnose a channel property with POST /property-check and GET /room-rates (sandbox by default).
 * Prints only Zodomus' status envelope (codes and messages) and room/rate counts — no credentials.
 *
 *   npm run zodomus:check -- 17446591
 *
 * property-check is the same call the "Check status" button makes; it changes nothing at Booking.com.
 */
import 'dotenv/config';
import { loadConfig } from '../config/env.js';

const pid = process.argv[2]?.trim();
if (!pid || !/^[A-Za-z0-9_-]{1,40}$/.test(pid)) {
  process.stdout.write('Usage: npm run zodomus:check -- <channel property id>\n');
  process.exit(2);
}
const z = loadConfig().zodomus;
const out = (s: string) => process.stdout.write(`${s}\n`);
out(`Zodomus ${z.environment} · channelId 1 (Booking.com) · propertyId ${pid}`);
const show = (label: string, r: { outcome: string; httpStatus: number | null; data?: unknown; error?: { message: string } }) => {
  const status = (r.data as { status?: unknown } | undefined)?.status;
  out(`\n${label}: ${r.outcome} (HTTP ${r.httpStatus ?? '-'})`);
  out(`status: ${JSON.stringify(status ?? null)}`);
  if (r.error) out(`error: ${r.error.message}`);
};
// Raw call (bypasses StaySync's PROVIDER_ERROR handling) so the full status envelope can be shown.
const raw = async (path: string, init: RequestInit) => {
  const res = await fetch(`${z.baseUrl}${path}`, { ...init, headers: { Authorization: `Basic ${Buffer.from(`${z.username}:${z.password}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(z.timeoutMs) });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { outcome: res.ok ? 'HTTP_OK' : 'HTTP_ERROR', httpStatus: res.status, data };
};
show('POST /property-check', await raw('/property-check', { method: 'POST', body: JSON.stringify({ channelId: 1, propertyId: pid }) }));
const rr = await raw(`/room-rates?channelId=1&propertyId=${encodeURIComponent(pid)}`, { method: 'GET' });
show('GET /room-rates', rr);
const rooms = (rr.data as { rooms?: { rates?: unknown[] }[] } | null)?.rooms;
if (Array.isArray(rooms)) out(`rooms: ${rooms.length}, rates: ${rooms.reduce((n, r) => n + (Array.isArray(r.rates) ? r.rates.length : 0), 0)}`);
