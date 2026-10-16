/**
 * Calendar dates are plain YYYY-MM-DD strings in the property's own time zone (no time, no offset).
 * They are stored in PostgreSQL `date` columns, which Prisma maps to JS Dates at UTC midnight.
 */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Today's calendar date in an IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Dates in [from, to) — `to` exclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}
export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Groups consecutive dates with equal values into [dateFrom, dateTo) segments. Dates whose value is
 * `null` are skipped (they break a segment and are not sent).
 */
export function toSegments<T>(dates: string[], valueOf: (date: string) => T | null, key: (v: T) => string): { dateFrom: string; dateTo: string; value: T }[] {
  const out: { dateFrom: string; dateTo: string; value: T }[] = [];
  let cur: { dateFrom: string; dateTo: string; value: T; k: string } | null = null;
  for (const d of dates) {
    const v = valueOf(d);
    if (v === null) {
      if (cur) out.push({ dateFrom: cur.dateFrom, dateTo: cur.dateTo, value: cur.value });
      cur = null;
      continue;
    }
    const k = key(v);
    if (cur && cur.k === k && cur.dateTo === d) {
      cur.dateTo = addDays(d, 1);
    } else {
      if (cur) out.push({ dateFrom: cur.dateFrom, dateTo: cur.dateTo, value: cur.value });
      cur = { dateFrom: d, dateTo: addDays(d, 1), value: v, k };
    }
  }
  if (cur) out.push({ dateFrom: cur.dateFrom, dateTo: cur.dateTo, value: cur.value });
  return out;
}

/** Number of fraction digits of an ISO 4217 currency (INR 2, JPY 0, …). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyDigits(currency));
}

/** Minor units → decimal string as Zodomus expects ("###.##"). */
export function minorToDecimal(minor: number, currency: string): string {
  const d = currencyDigits(currency);
  return (minor / 10 ** d).toFixed(d);
}
