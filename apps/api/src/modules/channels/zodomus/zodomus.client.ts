import type { Logger } from 'pino';
import { parseStatus } from './zodomus.mappers.js';
import type { CallContext, CallOutcome, CallRecorder, ProviderCallResult, ProviderEnvironment } from '../channel-provider.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Read-only account calls (Milestone 4). */
export const ZODOMUS_READ_OPERATIONS = {
  account: '/account',
  channels: '/channels',
  currencies: '/currencies',
  priceModels: '/price-model',
} as const;
export type ZodomusReadOperation = keyof typeof ZODOMUS_READ_OPERATIONS;

/**
 * Every operation this build may call, as defined in the authenticated Zodomus API reference
 * (swagger.json, read 16 Oct 2026; see docs/zodomus-api.md). Nothing outside this list can be sent.
 * `retry` is true only for idempotent calls: GETs and "set value" POSTs (availability, rates).
 * Card data (GET /reservations-cc) is deliberately absent.
 */
export const ZODOMUS_OPERATIONS = {
  account: { method: 'GET', path: '/account', retry: true },
  channels: { method: 'GET', path: '/channels', retry: true },
  currencies: { method: 'GET', path: '/currencies', retry: true },
  priceModels: { method: 'GET', path: '/price-model', retry: true },
  roomRates: { method: 'GET', path: '/room-rates', retry: true },
  availabilityGet: { method: 'GET', path: '/availability', retry: true },
  propertyActivation: { method: 'POST', path: '/property-activation', retry: false },
  propertyCheck: { method: 'POST', path: '/property-check', retry: false },
  propertyCancellation: { method: 'POST', path: '/property-cancellation', retry: false },
  roomsActivation: { method: 'POST', path: '/rooms-activation', retry: false },
  availability: { method: 'POST', path: '/availability', retry: true },
  rates: { method: 'POST', path: '/rates', retry: true },
  ratesDerived: { method: 'POST', path: '/rates-derived', retry: true },
  reservationsQueue: { method: 'GET', path: '/reservations-queue', retry: true },
  reservations: { method: 'GET', path: '/reservations', retry: true },
  reservationsSummary: { method: 'GET', path: '/reservations-summary', retry: true },
  // Sandbox only (the adapter refuses it in production).
  reservationsCreateTest: { method: 'POST', path: '/reservations-createtest', retry: false },
  promotions: { method: 'GET', path: '/promotions', retry: true },
  promotionActivate: { method: 'POST', path: '/activate-promotion', retry: false },
  promotionDeactivate: { method: 'POST', path: '/deactivate-promotion', retry: false },
} as const;
export type ZodomusOperation = keyof typeof ZODOMUS_OPERATIONS;

export class ProductionWriteBlockedError extends Error {
  constructor(message = 'Writes to the Zodomus production environment are disabled (set ZODOMUS_ALLOW_PRODUCTION_WRITES=true).') {
    super(message);
    this.name = 'ProductionWriteBlockedError';
  }
}

export interface ZodomusClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  environment: ProviderEnvironment;
  timeoutMs: number;
  logger: Logger;
  recorder?: CallRecorder;
  fetch?: FetchLike;
  /** Retries for idempotent GETs on 429/5xx/network/timeout (default 2). */
  maxRetries?: number;
  /** Base backoff in ms (default 300). Tests set 0. */
  backoffMs?: number;
  maxResponseBytes?: number;
  /** Production writes are refused unless explicitly enabled (never in tests or development). */
  allowProductionWrites?: boolean;
}

/** status.returnCode of a successful Zodomus call (confirmed with the sandbox probe, 16 Oct 2026). */
export const ZODOMUS_SUCCESS_CODE = 200;

class ResponseTooLargeError extends Error {}
type AttemptResult = Omit<ProviderCallResult, 'durationMs' | 'attempts' | 'operation'> & { retryAfterMs?: number };

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
  AUTH_ERROR: 'Zodomus rejected the API credentials. Check ZODOMUS_API_USERNAME and ZODOMUS_API_PASSWORD.',
  CLIENT_ERROR: 'Zodomus rejected the request.',
  RATE_LIMITED: 'Zodomus is rate limiting requests. Try again later.',
  SERVER_ERROR: 'Zodomus returned a server error.',
  TIMEOUT: 'Zodomus did not respond in time.',
  NETWORK_ERROR: 'Could not reach Zodomus (network or DNS error).',
  INVALID_RESPONSE: 'Zodomus returned a response that is not valid JSON.',
  PROVIDER_ERROR: 'Zodomus reported an error.',
};

/**
 * Minimal Zodomus HTTP client restricted to the operations in ZODOMUS_OPERATIONS.
 * - HTTP Basic auth over HTTPS; credentials stay in this object and are never logged or returned.
 * - Timeout per attempt, bounded retries with backoff for idempotent GETs, response size cap.
 * - Every call is logged and recorded as metadata only (operation, status, duration), never bodies.
 */
export class ZodomusClient {
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: ZodomusClientOptions) {
    if (!opts.baseUrl.startsWith('https://')) throw new Error('Zodomus base URL must use https');
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')}`;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 300;
    this.maxBytes = opts.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  /** Never expose credentials through util.inspect / JSON.stringify / logging of this object. */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.opts.baseUrl, environment: this.opts.environment };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `ZodomusClient(${this.opts.environment})`;
  }

  get(operation: ZodomusReadOperation, ctx: CallContext = {}): Promise<ProviderCallResult> {
    if (!Object.hasOwn(ZODOMUS_READ_OPERATIONS, operation)) return Promise.reject(new Error(`Operation not allowed: ${String(operation)}`));
    return this.call(operation, {}, ctx);
  }

  /**
   * Calls an allowlisted operation. GET parameters go in the query string, POST parameters in a JSON body.
   * Bodies and query values are never logged or recorded (they can contain property identifiers and prices).
   */
  async call(operation: ZodomusOperation, params: { query?: Record<string, string | number>; body?: unknown }, ctx: CallContext = {}): Promise<ProviderCallResult> {
    const def = Object.hasOwn(ZODOMUS_OPERATIONS, operation) ? ZODOMUS_OPERATIONS[operation] : undefined;
    if (!def) throw new Error(`Operation not allowed: ${String(operation)}`);
    if (def.method === 'POST' && this.opts.environment === 'production' && !this.opts.allowProductionWrites) throw new ProductionWriteBlockedError();
    const path = def.path;
    const qs = params.query ? `?${new URLSearchParams(Object.entries(params.query).map(([k, v]): [string, string] => [k, String(v)])).toString()}` : '';
    const url = `${this.opts.baseUrl}${path}${qs}`;
    const body = def.method === 'POST' ? JSON.stringify(params.body ?? {}) : undefined;
    const started = performance.now();
    let attempts = 0;
    let result: AttemptResult;

    for (;;) {
      attempts++;
      result = await this.attempt(url, def.method, body);
      if (!def.retry || !RETRYABLE.has(result.outcome) || attempts > this.maxRetries) break;
      await sleep(this.delayFor(attempts, result.retryAfterMs));
    }

    const durationMs = Math.round(performance.now() - started);
    const final: ProviderCallResult = { operation, durationMs, attempts, ok: result.ok, httpStatus: result.httpStatus, outcome: result.outcome, data: result.data, error: result.error, providerCode: result.providerCode ?? null, providerMessage: result.providerMessage ?? null };
    const level = final.ok ? 'info' : final.outcome === 'AUTH_ERROR' || final.outcome === 'CLIENT_ERROR' ? 'warn' : 'error';
    this.opts.logger[level](
      { provider: 'zodomus', environment: this.opts.environment, operation, path, httpStatus: final.httpStatus, outcome: final.outcome, providerCode: final.providerCode, durationMs, attempts, requestId: ctx.requestId },
      'zodomus call',
    );
    try {
      await this.opts.recorder?.record({
        provider: 'zodomus',
        environment: this.opts.environment,
        operation,
        httpMethod: def.method,
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

  private async attempt(url: string, method: 'GET' | 'POST' = 'GET', body?: string): Promise<AttemptResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        body,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          'User-Agent': 'StaySync/0.1 (+channel-manager)',
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

    const outcome = classify(res.status);
    if (outcome !== 'SUCCESS') {
      // Error bodies may carry the Zodomus status envelope; keep only returnCode/returnMessage.
      const status = await this.readCapped(res, 64 * 1024)
        .then((t) => parseStatus(JSON.parse(t)))
        .catch(() => null);
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        ok: false,
        httpStatus: res.status,
        outcome,
        providerCode: status?.returnCode ?? null,
        providerMessage: status?.returnMessage ?? null,
        error: { code: outcome, message: `${MESSAGES[outcome]} (HTTP ${res.status})` },
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    }

    try {
      const text = await this.readCapped(res);
      const data: unknown = text.trim() === '' ? null : JSON.parse(text);
      const status = parseStatus(data);
      // Confirmed with the sandbox: successful calls carry status.returnCode 200 ("OK").
      // Any other code inside an HTTP 2xx reply is an error reported by Zodomus.
      if (status && status.returnCode !== null && status.returnCode !== ZODOMUS_SUCCESS_CODE) {
        return {
          ok: false,
          httpStatus: res.status,
          outcome: 'PROVIDER_ERROR',
          providerCode: status.returnCode,
          providerMessage: status.returnMessage,
          error: { code: 'PROVIDER_ERROR', message: `${MESSAGES.PROVIDER_ERROR} (code ${status.returnCode}${status.returnMessage ? `: ${status.returnMessage.slice(0, 120)}` : ''})` },
        };
      }
      return { ok: true, httpStatus: res.status, outcome: 'SUCCESS', data, providerCode: status?.returnCode ?? null, providerMessage: status?.returnMessage ?? null };
    } catch (err) {
      const tooLarge = err instanceof ResponseTooLargeError;
      return {
        ok: false,
        httpStatus: res.status,
        outcome: 'INVALID_RESPONSE',
        error: { code: tooLarge ? 'RESPONSE_TOO_LARGE' : 'INVALID_RESPONSE', message: tooLarge ? 'Zodomus response exceeded the size limit.' : MESSAGES.INVALID_RESPONSE },
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
