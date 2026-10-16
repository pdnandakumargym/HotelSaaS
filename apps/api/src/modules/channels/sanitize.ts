/**
 * Provider responses are untrusted and their full schemas are not public. Before anything is
 * stored or shown, keys that could carry credentials or payment data are dropped and the size
 * is bounded. Keys ending in "key" are dropped too (Zodomus GET /account returns a `webhook_key`).
 */
const SENSITIVE_KEY =
  /(pass(word|wd)?|secret|token|api[_-]?(key|user)|auth|credential|card|cvv|cvc|iban|bic|swift|account[_-]?number|^user(name)?$|^login$|^cc([_-].*)?$|^cc(num|number|exp|holder)|key$)/i;

const MAX_DEPTH = 8;
const MAX_ARRAY = 1000;
const MAX_KEYS = 200;
const MAX_STRING = 2000;

export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizePayload(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitizePayload(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** Number of items when the payload is a list, or an object wrapping exactly one list. */
export function countItems(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === 'object') {
    const arrays = Object.values(payload as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return (arrays[0] as unknown[]).length;
  }
  return null;
}

/**
 * Structure-only summary (keys and types, no values) for diagnostics. Safe to print or paste.
 */
export function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [describeShape(value[0], depth + 1), `(${value.length} items)`];
  if (typeof value === 'object') {
    if (depth >= 6) return 'object';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[sensitive key, omitted]' : describeShape(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}
