import type { ReferenceKind } from '../channel-provider.js';

/**
 * Response shapes confirmed against the Zodomus sandbox with `npm run zodomus:probe` (16 Oct 2026).
 * Every response carries a `status` envelope:
 *   { status: { returnCode: number, returnMessage: string, channelLogId: string, channelOtherMessages: string, timestamp: string }, ... }
 * and then one payload key: `account` (object), `channels` [{id, channel}], `currencies` [{code, name}], `models` [{id, model}].
 */

export interface ZodomusStatus {
  returnCode: number | null;
  returnMessage: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 300) : null);
/** String or number id → trimmed string; anything else → null. */
const idStr = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() || null : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null);

export function parseStatus(data: unknown): ZodomusStatus | null {
  if (!isObj(data) || !isObj(data['status'])) return null;
  const s = data['status'];
  // When returnMessage is empty, Zodomus may put the channel's explanation in channelOtherMessages.
  // returnMessage is usually a string, but property-check returns an object of named checks, e.g.
  // { "Property status": "Evaluation OTA", "Room status": "Error: Some rooms are not maped…" }.
  const rm = s['returnMessage'];
  const msg = isObj(rm)
    ? str(
        Object.entries(rm)
          .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join('; '),
      )
    : str(rm);
  const other = str(s['channelOtherMessages']);
  const combined = msg && other && other !== msg ? `${msg} — ${other}` : (msg ?? other);
  return { returnCode: num(s['returnCode']), returnMessage: combined ? combined.slice(0, 300) : null };
}

export interface NormalizedAccount {
  name: string | null;
  city: string | null;
  country: string | null;
  apiStatus: string | null;
  webhookConfigured: boolean;
}
export interface IdName {
  id: number | string;
  name: string;
}
export interface CodeName {
  code: string;
  name: string;
}

/**
 * Keeps only the fields StaySync needs (data minimisation). Contact details of the platform's
 * Zodomus account and the webhook key are deliberately not stored. Returns null when the shape
 * is not the confirmed one, so the caller can fall back to the generic sanitizer.
 */
export function normalizeReference(kind: ReferenceKind, data: unknown): unknown {
  if (!isObj(data)) return null;
  switch (kind) {
    case 'account': {
      const a = data['account'];
      if (!isObj(a)) return null;
      const account: NormalizedAccount = {
        name: str(a['name']),
        city: str(a['city']),
        country: str(a['country']),
        apiStatus: str(a['api_status'] ?? a['apiStatus']),
        webhookConfigured: !!str(a['webhook']),
      };
      return account;
    }
    case 'channels':
      return list(data['channels'], (r) => {
        const id = num(r['id']);
        const name = str(r['channel']);
        return id !== null && name ? ({ id, name } satisfies IdName) : null;
      });
    case 'currencies':
      return list(data['currencies'], (r) => {
        const code = str(r['code']);
        const name = str(r['name']);
        return code && name ? ({ code: code.toUpperCase(), name } satisfies CodeName) : null;
      });
    case 'price_models':
      return list(data['models'], (r) => {
        const id = num(r['id']);
        const name = str(r['model']);
        return id !== null && name ? ({ id, name } satisfies IdName) : null;
      });
  }
}

function list<T>(v: unknown, map: (r: Obj) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v.slice(0, 1000)) {
    if (!isObj(item)) return null;
    const m = map(item);
    if (m === null) return null;
    out.push(m);
  }
  return out;
}

/** GET /room-rates → rooms: [{ id: int, name, rates: [{ id: string, name, active: string, maxPersons: int, policy, policyId }] }] (swagger "room"). */
export function normalizeRoomRates(data: unknown): { id: string; name: string; rates: { id: string; name: string; active: boolean | null; maxPersons: number | null }[] }[] | null {
  if (!isObj(data) || !Array.isArray(data['rooms'])) return null;
  const out = [];
  for (const r of data['rooms'].slice(0, 500)) {
    if (!isObj(r)) return null;
    const id = idStr(r['id']);
    if (!id) return null;
    const rates = [];
    for (const rate of Array.isArray(r['rates']) ? r['rates'].slice(0, 200) : []) {
      if (!isObj(rate)) continue;
      const rid = idStr(rate['id']);
      if (!rid) continue;
      const active = rate['active'];
      rates.push({
        id: rid.slice(0, 40),
        name: str(rate['name']) ?? `Rate ${rid}`,
        active: typeof active === 'boolean' ? active : typeof active === 'string' || typeof active === 'number' ? (String(active) === '' ? null : ['1', 'true', 'yes', 'active'].includes(String(active).toLowerCase())) : null,
        maxPersons: num(rate['maxPersons']),
      });
    }
    out.push({ id: id.slice(0, 40), name: str(r['name']) ?? `Room ${id}`, rates });
  }
  return out;
}
