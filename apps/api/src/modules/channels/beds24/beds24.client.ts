import type { Logger } from 'pino';
import type { CallContext, CallOutcome, CallRecorder, ProviderCallResult } from '../channel-provider.js';
import { ProductionWriteBlockedError, type FetchLike } from '../zodomus/zodomus.client.js';

/**
 * Every Beds24 API v2 operation this build may call (https://beds24.com/api/v2/apiV2.yaml, read 20 Oct 2026;
 * see docs/beds24-api.md). Nothing outside this list can be sent. `retry` only for idempotent calls.
 * Card data is never requested: no `includeInvoiceItems`/card endpoints, and the booking fields
 * `stripeToken` / `pcibookingToken` are dropped by the parser.
 */
export const BEDS24_OPERATIONS = {
  /** Exchange a one-time invite code for a refresh token (CLI only). */
  authSetup: { method: 'GET', path: '/authentication/setup', retry: false },
  authToken: { method: 'GET', path: '/authentication/token', retry: true },
  authDetails: { method: 'GET', path: '/authentication/details', retry: true },
  properties: { method: 'GET', path: '/properties', retry: true },
  calendarGet: { method: 'GET', path: '/inventory/rooms/calendar', retry: true },
  /** Sets values for date ranges (repeating it gives the same result). */
  calendarSet: { method: 'POST', path: '/inventory/rooms/calendar', retry: true },
  bookings: { method: 'GET', path: '/bookings', retry: true },
} as const;
export type Beds24Operation = keyof typeof BEDS24_OPERATIONS;

export class Beds24WriteBlockedError extends ProductionWriteBlockedError {
  constructor(message: string) {
    super(message);
    this.name = 'Beds24WriteBlockedError';
  }
}

export interface Beds24ClientOptions {
  baseUrl: string;
  refreshToken: string;
  timeoutMs: number;
  logger: Logger;
  recorder?: CallRecorder;
  fetch?: FetchLike;
  maxRetries?: number;
  backoffMs?: number;
  maxResponseBytes?: number;
  /** Calendar writes are refused unless explicitly enabled (Beds24 accounts are always live). */
  allowWrites?: boolean;
  /** Writes are refused until it is confirmed whether the calendar `to` date is included (null = unknown). */
  calendarToInclusive?: boolean | null;
  now?: () => number;
}

/** Five-minute credit budget reported by Beds24 on every response. */
export interface Beds24Credits {
  limit: number | null;
  remaining: number | null;
  resetsInSeconds: number | null;
  lastRequestCost: number | null;
  observedAt: string;
}

type QueryValue = string | number | boolean | undefined | readonly string[];
type Params = { query?: Record<string, QueryValue>; body?: unknown; headers?: Record<string, string> };
type AttemptResult = Omit<ProviderCallResult, 'durationMs' | 'attempts' | 'operation'> & { retryAfterMs?: number };

class ResponseTooLargeError extends Error {}
const RETRYABLE: ReadonlySet<CallOutcome> = new Set(['RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

function classify(status: number): CallOutcome {
  if (status >= 200 && status < 300) return 'SUCCESS';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'CLIENT_ERROR';
}

const MESSAGES: Record<CallOutcome, string> = {
  SUCCESS: 'OK',
  AUTH_ERROR: 'Beds24 rejected the token. Create a new refresh token with npm run beds24:setup and check its scopes.',
  CLIENT_ERROR: 'Beds24 rejected the request.',
  RATE_LIMITED: 'The Beds24 five-minute credit limit is used up. Updates continue automatically when it resets.',
  SERVER_ERROR: 'Beds24 returned a server error.',
  TIMEOUT: 'Beds24 did not respond in time.',
  NETWORK_ERROR: 'Could not reach Beds24 (network or DNS error).',
  INVALID_RESPONSE: 'Beds24 returned a response that is not valid JSON.',
  PROVIDER_ERROR: 'Beds24 reported an error.',
};

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Minimal Beds24 API v2 client restricted to BEDS24_OPERATIONS.
 * - Long-life refresh token → short-life access token (kept in memory only, renewed before expiry or after a 401).
 * - Tokens are never logged, recorded, returned or serialised.
 * - Respects the five-minute credit budget: when it is used up, calls are not sent until it resets.
 * - Timeout per attempt, bounded retries for idempotent calls, response size cap, no redirects.
 */
export class Beds24Client {
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<AttemptResult> | null = null;
  private credits: Beds24Credits | null = null;

  constructor(private readonly opts: Beds24ClientOptions) {
    if (!opts.baseUrl.startsWith('https://')) throw new Error('Beds24 base URL must use https');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.maxBytes = opts.maxResponseBytes ?? 4 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.opts.baseUrl };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Beds24Client';
  }

  /** Last credit information seen (no secrets). */
  creditStatus(): Beds24Credits | null {
    return this.credits ? { ...this.credits } : null;
  }

  /** Throws when calendar writes are not allowed yet. */
  assertWritable(): void {
    if (!this.opts.allowWrites) throw new Beds24WriteBlockedError('Beds24 calendar writes are disabled (set BEDS24_ALLOW_WRITES=true once the mapping is checked).');
    if (this.opts.calendarToInclusive === null || this.opts.calendarToInclusive === undefined) {
      throw new Beds24WriteBlockedError('Beds24 calendar writes are disabled until BEDS24_CALENDAR_TO_INCLUSIVE is set (run npm run beds24:check).');
    }
  }

  get calendarToInclusive(): boolean | null {
    return this.opts.calendarToInclusive ?? null;
  }

  async call(operation: Exclude<Beds24Operation, 'authSetup' | 'authToken'>, params: Params = {}, ctx: CallContext = {}): Promise<ProviderCallResult> {
    const def = Object.hasOwn(BEDS24_OPERATIONS, operation) ? BEDS24_OPERATIONS[operation] : undefined;
    if (!def || operation === ('authSetup' as string) || operation === ('authToken' as string)) throw new Error(`Operation not allowed: ${String(operation)}`);
    if (def.method === 'POST') this.assertWritable();
    const started = performance.now();
    let attempts = 0;
    let result: AttemptResult;
    let reauthed = false;
    for (;;) {
      const blocked = this.creditBlock();
      if (blocked) {
        result = blocked;
        break;
      }
      const token = await this.token(ctx);
      if (!token.ok) {
        result = token.result;
        break;
      }
      attempts++;
      result = await this.attempt(this.url(def.path, params.query), def.method, def.method === 'POST' ? JSON.stringify(params.body ?? []) : undefined, { token: token.value });
      // An access token can be revoked or expire early: renew it once.
      if (result.outcome === 'AUTH_ERROR' && !reauthed) {
        reauthed = true;
        this.accessToken = null;
        continue;
      }
      if (!def.retry || !RETRYABLE.has(result.outcome) || attempts > this.maxRetries) break;
      await sleep(this.delayFor(attempts, result.retryAfterMs));
    }
    return this.finish(operation, def.method, def.path, started, attempts, result, ctx);
  }

  /**
   * One-time invite code → refresh token (used only by the setup CLI). The returned token is a secret:
   * the caller prints it once for the operator; it is never logged or recorded here.
   */
  async setup(inviteCode: string, deviceName: string): Promise<{ ok: boolean; refreshToken?: string; error?: string }> {
    const r = await this.attempt(this.url(BEDS24_OPERATIONS.authSetup.path), 'GET', undefined, { code: inviteCode, deviceName });
    if (!r.ok) return { ok: false, error: r.error?.message ?? r.outcome };
    const d = r.data as { refreshToken?: unknown } | null;
    return typeof d?.refreshToken === 'string' && d.refreshToken ? { ok: true, refreshToken: d.refreshToken } : { ok: false, error: 'Beds24 did not return a refresh token.' };
  }

  private url(path: string, query?: Params['query']): string {
    const q = new URLSearchParams();
    // Array parameters are sent as repeated keys (OpenAPI default: form, explode).
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v as readonly string[]) q.append(k, x);
      else q.append(k, String(v));
    }
    const qs = q.toString();
    return `${this.opts.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private creditBlock(): AttemptResult | null {
    const c = this.credits;
    if (!c || c.remaining === null || c.remaining > 0 || c.resetsInSeconds === null) return null;
    const resetAt = Date.parse(c.observedAt) + c.resetsInSeconds * 1000;
    if (this.now() >= resetAt) return null;
    return { ok: false, httpStatus: null, outcome: 'RATE_LIMITED', error: { code: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED } };
  }

  private async token(ctx: CallContext): Promise<{ ok: true; value: string } | { ok: false; result: AttemptResult }> {
    if (this.accessToken && this.accessToken.expiresAt > this.now() + 60_000) return { ok: true, value: this.accessToken.value };
    // One refresh at a time, shared by concurrent callers.
    this.refreshing ??= this.refresh(ctx).finally(() => {
      this.refreshing = null;
    });
    const r = await this.refreshing;
    if (!r.ok || !this.accessToken) return { ok: false, result: r.ok ? { ok: false, httpStatus: r.httpStatus, outcome: 'INVALID_RESPONSE', error: { code: 'INVALID_RESPONSE', message: 'Beds24 did not return an access token.' } } : r };
    return { ok: true, value: this.accessToken.value };
  }

  private async refresh(ctx: CallContext): Promise<AttemptResult> {
    const started = performance.now();
    let attempts = 0;
    let r: AttemptResult;
    for (;;) {
      attempts++;
      r = await this.attempt(this.url(BEDS24_OPERATIONS.authToken.path), 'GET', undefined, { refreshToken: this.opts.refreshToken });
      if (!RETRYABLE.has(r.outcome) || attempts > this.maxRetries) break;
      await sleep(this.delayFor(attempts, r.retryAfterMs));
    }
    if (r.ok) {
      const d = r.data as { token?: unknown; expiresIn?: unknown } | null;
      if (typeof d?.token === 'string' && d.token) {
        const ttl = typeof d.expiresIn === 'number' && d.expiresIn > 0 ? d.expiresIn : 3600;
        this.accessToken = { value: d.token, expiresAt: this.now() + ttl * 1000 };
      } else {
        r = { ok: false, httpStatus: r.httpStatus, outcome: 'INVALID_RESPONSE', error: { code: 'INVALID_RESPONSE', message: 'Beds24 did not return an access token.' } };
      }
    }
    // Never keep the token in the recorded result.
    const recorded: AttemptResult = { ...r, data: undefined };
    await this.finish('authToken', 'GET', BEDS24_OPERATIONS.authToken.path, started, attempts, recorded, ctx);
    return recorded;
  }

  private async finish(operation: Beds24Operation, method: 'GET' | 'POST', path: string, started: number, attempts: number, result: AttemptResult, ctx: CallContext): Promise<ProviderCallResult> {
    const durationMs = Math.round(performance.now() - started);
    const final: ProviderCallResult = { operation, durationMs, attempts, ok: result.ok, httpStatus: result.httpStatus, outcome: result.outcome, data: result.data, error: result.error, providerCode: result.providerCode ?? null, providerMessage: result.providerMessage ?? null };
    const level = final.ok ? 'info' : final.outcome === 'AUTH_ERROR' || final.outcome === 'CLIENT_ERROR' ? 'warn' : 'error';
    this.opts.logger[level](
      { provider: 'beds24', operation, path, httpStatus: final.httpStatus, outcome: final.outcome, providerCode: final.providerCode, durationMs, attempts, creditsRemaining: this.credits?.remaining ?? null, requestId: ctx.requestId },
      'beds24 call',
    );
    try {
      await this.opts.recorder?.record({
        provider: 'beds24',
        environment: 'production',
        operation,
        httpMethod: method,
        path,
        httpStatus: final.httpStatus,
        outcome: final.outcome,
        durationMs,
        attempts,
        errorCode: final.error?.code,
        errorMessage: final.error?.message,
        providerCode: final.providerCode,
        providerMessage: final.providerMessage,
        requestId: ctx.requestId,
        actorUserId: ctx.actorUserId,
      });
    } catch (err) {
      this.opts.logger.error({ err: (err as Error).message }, 'could not record integration call');
    }
    return final;
  }

  private delayFor(attempt: number, retryAfterMs?: number): number {
    if (this.backoffMs === 0) return 0;
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 5_000);
    return this.backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * this.backoffMs);
  }

  private readCredits(res: Response): void {
    const limit = num(res.headers.get('x-fivemincreditlimit'));
    const remaining = num(res.headers.get('x-fivemincreditlimit-remaining'));
    const resets = num(res.headers.get('x-fivemincreditlimit-resetsin'));
    const cost = num(res.headers.get('x-requestcost'));
    if (limit === null && remaining === null && resets === null && cost === null) return;
    this.credits = { limit, remaining, resetsInSeconds: resets, lastRequestCost: cost, observedAt: new Date(this.now()).toISOString() };
  }

  private async attempt(url: string, method: 'GET' | 'POST', body: string | undefined, auth: Record<string, string>): Promise<AttemptResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        body,
        headers: {
          ...auth,
          Accept: 'application/json',
          'User-Agent': 'StaySync/1.0 (+channel-manager)',
          ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      const outcome: CallOutcome = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      return { ok: false, httpStatus: null, outcome, error: { code: outcome, message: MESSAGES[outcome] } };
    }
    this.readCredits(res);

    const outcome = classify(res.status);
    if (outcome !== 'SUCCESS') {
      // Documented error body: { success, type, code, error }. Keep only code and a short message.
      const err = await this.readCapped(res, 64 * 1024)
        .then((t) => JSON.parse(t) as { code?: unknown; error?: unknown })
        .catch(() => null);
      const retryAfter = num(res.headers.get('retry-after')) ?? (outcome === 'RATE_LIMITED' ? this.credits?.resetsInSeconds ?? null : null);
      return {
        ok: false,
        httpStatus: res.status,
        outcome,
        providerCode: typeof err?.code === 'number' ? err.code : null,
        providerMessage: typeof err?.error === 'string' ? err.error.slice(0, 200) : null,
        error: { code: outcome, message: `${MESSAGES[outcome]} (HTTP ${res.status}${typeof err?.error === 'string' ? `: ${err.error.slice(0, 120)}` : ''})` },
        retryAfterMs: retryAfter !== null && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    }

    try {
      const text = await this.readCapped(res);
      const data: unknown = text.trim() === '' ? null : JSON.parse(text);
      // Envelope { success: false, code, error } inside a 2xx reply.
      if (data && typeof data === 'object' && !Array.isArray(data) && (data as { success?: unknown }).success === false) {
        const d = data as { code?: unknown; error?: unknown };
        const message = typeof d.error === 'string' ? d.error.slice(0, 200) : null;
        return {
          ok: false,
          httpStatus: res.status,
          outcome: 'PROVIDER_ERROR',
          providerCode: typeof d.code === 'number' ? d.code : null,
          providerMessage: message,
          error: { code: 'PROVIDER_ERROR', message: `${MESSAGES.PROVIDER_ERROR}${message ? ` (${message.slice(0, 120)})` : ''}` },
        };
      }
      return { ok: true, httpStatus: res.status, outcome: 'SUCCESS', data };
    } catch (err) {
      const tooLarge = err instanceof ResponseTooLargeError;
      return {
        ok: false,
        httpStatus: res.status,
        outcome: 'INVALID_RESPONSE',
        error: { code: tooLarge ? 'RESPONSE_TOO_LARGE' : 'INVALID_RESPONSE', message: tooLarge ? 'Beds24 response exceeded the size limit.' : MESSAGES.INVALID_RESPONSE },
      };
    }
  }

  private async readCapped(res: Response, cap = this.maxBytes): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap) throw new ResponseTooLargeError();
    if (!res.body) return '';
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done || !value) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
