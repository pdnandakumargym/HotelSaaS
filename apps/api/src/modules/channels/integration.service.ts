import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { CallRecord, CallRecorder, ChannelProvider, ProviderCallResult, ReferenceKind } from './channel-provider.js';
import { countItems, sanitizePayload } from './sanitize.js';
import { normalizeReference } from './zodomus/zodomus.mappers.js';

/** Persists call metadata (never bodies or credentials) for the API health view. */
export class DbCallRecorder implements CallRecorder {
  constructor(private readonly db: Database) {}

  async record(e: CallRecord): Promise<void> {
    await withSystem(this.db, (tx) =>
      tx.integrationCallLog.create({
        data: {
          provider: e.provider,
          environment: e.environment,
          operation: e.operation,
          httpMethod: e.httpMethod,
          path: e.path,
          httpStatus: e.httpStatus,
          outcome: e.outcome,
          durationMs: e.durationMs,
          attempts: Math.min(e.attempts, 10),
          errorCode: e.errorCode?.slice(0, 60),
          errorMessage: e.errorMessage?.slice(0, 300),
          providerCode: e.providerCode ?? null,
          providerMessage: e.providerMessage?.slice(0, 300) ?? null,
          requestId: e.requestId?.slice(0, 64),
          actorUserId: e.actorUserId,
        },
      }),
    );
  }
}

export type ConnectionState = 'disabled' | 'not_configured' | 'untested' | 'connected' | 'degraded' | 'failing';
export type CredentialState = 'not_configured' | 'unverified' | 'valid' | 'rejected';

export interface IntegrationHealth {
  connection: ConnectionState;
  credentials: CredentialState;
  window: { hours: number; calls: number; failures: number; errorRate: number | null; p50Ms: number | null; p95Ms: number | null };
  lastSuccessAt: Date | null;
  lastFailure: { at: Date; outcome: string; httpStatus: number | null; message: string | null } | null;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

/**
 * Platform-level integration management: configuration status, Test Connection, API health and
 * a cache of read-only reference data. Tenants never trigger provider calls in Milestone 4.
 */
export class IntegrationService {
  constructor(
    private readonly db: Database,
    private readonly provider: ChannelProvider,
    private readonly audit: AuditService,
    private readonly now: () => number = Date.now,
  ) {}

  configStatus() {
    return this.provider.configStatus();
  }

  async health(hours = 24): Promise<IntegrationHealth> {
    const cfg = this.provider.configStatus();
    const since = new Date(this.now() - hours * 3_600_000);
    const { recent, lastSuccess, lastFailure, lastAuthChecked } = await withSystem(this.db, async (tx) => {
      const where = { provider: cfg.provider, environment: cfg.environment };
      const [recent, lastSuccess, lastFailure, lastAuthChecked] = await Promise.all([
        tx.integrationCallLog.findMany({ where: { ...where, createdAt: { gte: since } }, select: { outcome: true, durationMs: true }, take: 5000, orderBy: { createdAt: 'desc' } }),
        tx.integrationCallLog.findFirst({ where: { ...where, outcome: 'SUCCESS' }, orderBy: { createdAt: 'desc' } }),
        tx.integrationCallLog.findFirst({ where: { ...where, outcome: { not: 'SUCCESS' } }, orderBy: { createdAt: 'desc' } }),
        // Only outcomes that prove something about the credentials.
        tx.integrationCallLog.findFirst({ where: { ...where, outcome: { in: ['SUCCESS', 'AUTH_ERROR'] } }, orderBy: { createdAt: 'desc' } }),
      ]);
      return { recent, lastSuccess, lastFailure, lastAuthChecked };
    });

    const failures = recent.filter((r) => r.outcome !== 'SUCCESS').length;
    const durations = recent.map((r) => r.durationMs).sort((a, b) => a - b);
    const errorRate = recent.length ? failures / recent.length : null;

    let connection: ConnectionState;
    let credentials: CredentialState;
    if (!cfg.enabled) {
      connection = 'disabled';
      credentials = cfg.credentialsConfigured ? 'unverified' : 'not_configured';
    } else if (!cfg.credentialsConfigured) {
      connection = 'not_configured';
      credentials = 'not_configured';
    } else {
      credentials = !lastAuthChecked ? 'unverified' : lastAuthChecked.outcome === 'SUCCESS' ? 'valid' : 'rejected';
      const lastCallFailed = lastFailure && (!lastSuccess || lastFailure.createdAt > lastSuccess.createdAt);
      if (!lastSuccess && !lastFailure) connection = 'untested';
      else if (lastCallFailed) connection = 'failing';
      else if (errorRate !== null && recent.length >= 10 && errorRate > 0.2) connection = 'degraded'; // ignore tiny samples
      else connection = 'connected';
    }

    return {
      connection,
      credentials,
      window: { hours, calls: recent.length, failures, errorRate, p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95) },
      lastSuccessAt: lastSuccess?.createdAt ?? null,
      lastFailure: lastFailure
        ? { at: lastFailure.createdAt, outcome: lastFailure.outcome, httpStatus: lastFailure.httpStatus, message: lastFailure.errorMessage }
        : null,
    };
  }

  recentCalls(limit = 50) {
    const cfg = this.provider.configStatus();
    return withSystem(this.db, (tx) =>
      tx.integrationCallLog.findMany({
        where: { provider: cfg.provider },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        select: { id: true, environment: true, operation: true, httpMethod: true, path: true, httpStatus: true, outcome: true, durationMs: true, attempts: true, errorCode: true, errorMessage: true, providerCode: true, providerMessage: true, requestId: true, createdAt: true },
      }),
    );
  }

  async testConnection(actor: { id: string }, meta: RequestMeta) {
    this.assertReady();
    const result = await this.provider.testConnection({ requestId: meta.requestId, actorUserId: actor.id });
    await this.audit.record({
      action: 'integration.connection_tested',
      actorUserId: actor.id,
      entityType: 'integration',
      entityId: this.provider.id,
      metadata: { outcome: result.outcome, httpStatus: result.httpStatus, durationMs: result.durationMs },
      ...meta,
    });
    return this.publicResult(result);
  }

  async refreshReference(kind: ReferenceKind, actor: { id: string }, meta: RequestMeta) {
    this.assertReady();
    const result = await this.provider.fetchReference(kind, { requestId: meta.requestId, actorUserId: actor.id });
    let stored: { fetchedAt: Date; itemCount: number | null } | null = null;
    if (result.ok) {
      const cfg = this.provider.configStatus();
      // Confirmed Zodomus shapes are reduced to the fields we need; anything unexpected is sanitized generically.
      const payload = (normalizeReference(kind, result.data) ?? sanitizePayload(result.data)) as Prisma.InputJsonValue;
      const itemCount = countItems(payload);
      const fetchedAt = new Date(this.now());
      await withSystem(this.db, (tx) =>
        tx.providerReferenceData.upsert({
          where: { provider_environment_kind: { provider: cfg.provider, environment: cfg.environment, kind } },
          create: { provider: cfg.provider, environment: cfg.environment, kind, payload, itemCount, fetchedAt, fetchedById: actor.id },
          update: { payload, itemCount, fetchedAt, fetchedById: actor.id },
        }),
      );
      stored = { fetchedAt, itemCount };
    }
    await this.audit.record({
      action: 'integration.reference_refreshed',
      actorUserId: actor.id,
      entityType: 'integration',
      entityId: `${this.provider.id}:${kind}`,
      metadata: { outcome: result.outcome, httpStatus: result.httpStatus, itemCount: stored?.itemCount ?? null },
      ...meta,
    });
    return { ...this.publicResult(result), stored };
  }

  /** Cached reference data for the current environment, or null if never fetched. */
  async reference(kind: ReferenceKind) {
    const cfg = this.provider.configStatus();
    const row = await withSystem(this.db, (tx) =>
      tx.providerReferenceData.findUnique({
        where: { provider_environment_kind: { provider: cfg.provider, environment: cfg.environment, kind } },
        select: { kind: true, environment: true, payload: true, itemCount: true, fetchedAt: true },
      }),
    );
    return row;
  }

  private assertReady() {
    if (!this.provider.isReady()) {
      throw new AppError(409, 'INTEGRATION_NOT_CONFIGURED', 'Zodomus is not enabled or its credentials are missing. Set ZODOMUS_ENABLED and the API credentials in the server environment.');
    }
  }

  /** What an admin may see about a call: no raw data for the connection test, no credentials ever. */
  private publicResult(r: ProviderCallResult) {
    return { ok: r.ok, operation: r.operation, outcome: r.outcome, httpStatus: r.httpStatus, durationMs: r.durationMs, attempts: r.attempts, providerCode: r.providerCode ?? null, providerMessage: r.providerMessage ?? null, error: r.error ?? null };
  }
}
