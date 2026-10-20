import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem } from '../../infrastructure/db/tenant.js';
import { requirePlatformPermission } from '../../middleware/auth.js';
import { registry } from '../../openapi/registry.js';
import { sendData } from '../../shared/http.js';

registry.registerPath({ method: 'get', path: '/api/v1/admin/system', tags: ['Admin'], summary: 'System health and configuration summary (no secrets)', responses: { 200: { description: 'OK' } } });

const STALE_MS = 2 * 60_000;

function expectedMigrations(): string[] | null {
  try {
    const dir = join(import.meta.dirname, '../../../prisma/migrations');
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return null;
  }
}

/** Mounted inside the admin router. Counts and settings only: no tenant data, no secrets. */
export function systemRouter(deps: { db: Database; config: AppConfig; version: string }): Router {
  const { db, config, version } = deps;
  const r = Router();
  r.get('/system', requirePlatformPermission('admin.integration.read'), async (_req, res) => {
    const started = performance.now();
    let dbOk = true;
    let dbLatencyMs: number | null = null;
    let applied: string[] | null = null;
    let data: Awaited<ReturnType<typeof load>> | null = null;
    async function load() {
      return withSystem(db, async (tx) => {
        const since = new Date(Date.now() - 24 * 3_600_000);
        const [heartbeats, byStatus, failed24h, oldestPending, pollFailing, photos, openDiscrepancies, orgs] = await Promise.all([
          tx.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' } }),
          tx.syncJob.groupBy({ by: ['status'], where: { status: { in: ['PENDING', 'RUNNING'] } }, _count: { _all: true } }),
          tx.syncJob.count({ where: { status: 'FAILED', finishedAt: { gte: since } } }),
          tx.syncJob.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
          tx.channelConnection.count({ where: { status: 'ACTIVE', reservationsPollFailures: { gte: 3 } } }),
          tx.photo.aggregate({ _count: { _all: true }, _sum: { bytes: true } }),
          tx.discrepancy.count({ where: { status: 'OPEN' } }),
          tx.organization.count(),
        ]);
        return { heartbeats, byStatus, failed24h, oldestPending, pollFailing, photos, openDiscrepancies, orgs };
      });
    }
    try {
      await db.$queryRaw`SELECT 1`;
      dbLatencyMs = Math.round(performance.now() - started);
      applied = (await db.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`).map((m) => m.migration_name);
      data = await load();
    } catch {
      dbOk = false;
    }
    const expected = expectedMigrations();
    const now = Date.now();
    const workers = (data?.heartbeats ?? []).map((h) => ({ id: h.id, role: h.role, version: h.version, startedAt: h.startedAt, lastSeenAt: h.lastSeenAt, stale: now - h.lastSeenAt.getTime() > STALE_MS, stats: h.stats }));
    const liveWorkers = workers.filter((w) => !w.stale).length;
    sendData(res, {
      app: { name: config.appName, version, nodeEnv: config.nodeEnv, node: process.version, uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() },
      database: {
        ok: dbOk,
        latencyMs: dbLatencyMs,
        migrationsApplied: applied?.length ?? null,
        latestMigration: applied?.at(-1) ?? null,
        pendingMigrations: expected && applied ? expected.filter((m) => !applied.includes(m)) : null,
      },
      workers: { live: liveWorkers, embeddedInApi: config.sync.workerEnabled, list: workers },
      queue: data
        ? {
            pending: data.byStatus.find((b) => b.status === 'PENDING')?._count._all ?? 0,
            running: data.byStatus.find((b) => b.status === 'RUNNING')?._count._all ?? 0,
            failed24h: data.failed24h,
            oldestPendingAt: data.oldestPending?.createdAt ?? null,
            reservationPollingFailing: data.pollFailing,
          }
        : null,
      usage: data ? { organizations: data.orgs, photos: data.photos._count._all, photoBytes: data.photos._sum.bytes ?? 0, openDiscrepancies: data.openDiscrepancies } : null,
      config: {
        zodomus: { enabled: config.zodomus.enabled, environment: config.zodomus.environment, credentialsConfigured: config.zodomus.credentialsConfigured, productionWritesAllowed: config.zodomus.allowProductionWrites },
        beds24: { enabled: config.beds24.enabled, credentialsConfigured: config.beds24.credentialsConfigured, writesAllowed: config.beds24.allowWrites, calendarToInclusive: config.beds24.calendarToInclusive ?? 'not set' },
        sync: { workerIntervalMs: config.sync.intervalMs, reservationPollMs: config.sync.reservationPollMs, horizonDays: config.sync.horizonDays },
        security: { cookieSecure: config.auth.cookieSecure, owner2faPolicy: config.auth.owner2faPolicy, trustProxy: String(config.trustProxy), corsOrigins: config.corsOrigins, apiDocsEnabled: config.apiDocsEnabled },
        mail: { transport: config.mail.transport },
        photos: { storageDir: config.photos.storageDir, publicLinksConfigured: !!config.photos.publicBaseUrl, maxUploadMb: Math.round(config.photos.maxUploadBytes / 1048576) },
      },
      checks: [
        { name: 'Database reachable', ok: dbOk },
        { name: 'All migrations applied', ok: !!expected && !!applied && expected.every((m) => applied.includes(m)) },
        { name: 'Background worker running', ok: liveWorkers > 0 },
        { name: 'No failed channel updates in 24 h', ok: (data?.failed24h ?? 1) === 0 },
        { name: 'Reservation polling healthy', ok: (data?.pollFailing ?? 1) === 0 },
        { name: 'Secure cookies', ok: config.auth.cookieSecure || config.nodeEnv !== 'production' },
      ],
    });
  });
  return r;
}
