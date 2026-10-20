import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import { requireAuth, requirePlatformPermission } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import type { ChannelConnectionService } from '../channels/connection.service.js';
import { retryFailedJob } from '../channels/sync.service.js';
import type { DiscrepancyService } from '../discrepancies/discrepancy.service.js';
import { orgRoleHas } from '../rbac/permissions.js';
import type { SupportAccessService } from '../support/support-access.service.js';
import { fromDbDate } from '../rates/dates.js';
import type { ReservationService } from './reservation.service.js';

for (const [method, path, summary, tag] of [
  ['get', '/organizations/{orgId}/reservations', 'Bookings received from channels (guest names only with booking.guest_pii.read)', 'Reservations'],
  ['get', '/organizations/{orgId}/reservations/{reservationId}', 'One booking; guest details only with booking.guest_pii.read (audited)', 'Reservations'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/reservations/poll', 'Fetch new, modified and cancelled bookings now (GET /reservations-queue, GET /reservations)', 'Reservations'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/reservations/import-summary', 'Import future bookings made before the connection (GET /reservations-summary)', 'Reservations'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/reservations/test', 'Sandbox only: create a test booking (POST /reservations-createtest)', 'Reservations'],
  ['get', '/organizations/{orgId}/sync-status', 'Synchronisation status per channel connection', 'Sync'],
  ['post', '/organizations/{orgId}/sync-jobs/{jobId}/retry', 'Queue a failed availability/rate update again', 'Sync'],
  ['get', '/organizations/{orgId}/discrepancies', 'Discrepancy center', 'Discrepancies'],
  ['post', '/organizations/{orgId}/discrepancies/{discrepancyId}/{decision}', 'Resolve, ignore or reopen a discrepancy', 'Discrepancies'],
  ['get', '/admin/support-access/{requestId}/reservations', 'Booking facts under an active support grant (no guest data; audited)', 'Admin'],
  ['get', '/admin/integrations/zodomus/sync', 'Platform-wide sync queue and reservation polling health (no tenant data)', 'Admin'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: [tag], summary, responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return v;
}
const optionalUuid = z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional());

const ListQuery = z.object({
  propertyId: optionalUuid,
  status: z.enum(['CONFIRMED', 'MODIFIED', 'CANCELLED']).optional(),
  view: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
  needsReview: z.enum(['true', 'false']).optional(),
  q: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Search by booking number')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const TestBody = z
  .object({
    status: z.enum(['new', 'modified', 'cancelled']),
    channelReservationId: z
      .string()
      .trim()
      .regex(/^[0-9]{1,20}$/, 'Use digits only')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .strict();
const DecisionBody = z.object({ note: z.string().trim().max(500).optional() }).strict();

const canSeeGuests = (req: Request) => orgRoleHas(req.org!.role, 'booking.guest_pii.read');

/** Mounted at /organizations/:orgId/reservations. */
export function reservationsRouter(deps: { reservations: ReservationService }): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  r.get('/', requireOrgPermission('booking.read'), async (req, res) => {
    const q = parseQuery(ListQuery, req);
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await deps.reservations.list(req.org!.organizationId, { ...q, needsReview: q.needsReview === 'true' }, canSeeGuests(req)));
  });

  r.get('/:reservationId', requireOrgPermission('booking.read'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await deps.reservations.get(req.org!.organizationId, uuidParam(req.params['reservationId']), canSeeGuests(req), req.auth!.user, requestMeta(req)));
  });
  return r;
}

/** Mounted at /organizations/:orgId/properties/:propertyId/channel-connections/:connectionId/reservations. */
export function connectionReservationsRouter(deps: { reservations: ReservationService; connections: ChannelConnectionService }): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth());
  const owned = async (req: Request) => {
    const orgId = req.org!.organizationId;
    const c = await deps.connections.get(orgId, uuidParam(req.params['connectionId']));
    if (c.propertyId !== uuidParam(req.params['propertyId'])) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    return { orgId, id: c.id };
  };

  r.post('/poll', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await deps.reservations.pollConnection(orgId, id, { requestId: req.requestId, actorUserId: req.auth!.user.id }));
  });
  r.post('/import-summary', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await deps.reservations.importSummary(orgId, id, req.auth!.user, requestMeta(req)));
  });
  r.post('/test', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await deps.reservations.createTest(orgId, id, parseBody(TestBody, req), req.auth!.user, requestMeta(req)));
  });
  return r;
}

/** Mounted at /organizations/:orgId (sync-status, sync-jobs, discrepancies). */
export function operationsRouter(deps: { db: Database; audit: AuditService; discrepancies: DiscrepancyService }): Router {
  const { db, audit, discrepancies } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  r.get('/sync-status', requireOrgPermission('property.read'), async (req, res) => {
    const { propertyId } = parseQuery(z.object({ propertyId: optionalUuid }), req);
    const orgId = req.org!.organizationId;
    const data = await withTenant(db, orgId, async (tx) => {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const conns = await tx.channelConnection.findMany({
        where: { ...(propertyId ? { propertyId } : {}), status: { not: 'DISCONNECTED' } },
        orderBy: { createdAt: 'asc' },
        include: { property: { select: { name: true } } },
      });
      return Promise.all(
        conns.map(async (c) => {
          const [byStatus, succeeded24h, failed24h, lastSuccess, recent, openDiscrepancies, lastReservation, reservationCount] = await Promise.all([
            tx.syncJob.groupBy({ by: ['status'], where: { connectionId: c.id, status: { in: ['PENDING', 'RUNNING'] } }, _count: { _all: true } }),
            tx.syncJob.count({ where: { connectionId: c.id, status: 'SUCCEEDED', finishedAt: { gte: since } } }),
            tx.syncJob.count({ where: { connectionId: c.id, status: 'FAILED', finishedAt: { gte: since } } }),
            tx.syncJob.findFirst({ where: { connectionId: c.id, status: 'SUCCEEDED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
            tx.syncJob.findMany({ where: { connectionId: c.id }, orderBy: { createdAt: 'desc' }, take: 25 }),
            tx.discrepancy.count({ where: { connectionId: c.id, status: 'OPEN' } }),
            tx.reservation.findFirst({ where: { connectionId: c.id }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
            tx.reservation.count({ where: { connectionId: c.id } }),
          ]);
          const count = (s: string) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
          const names = await tx.roomType.findMany({ where: { propertyId: c.propertyId }, select: { id: true, name: true } });
          const plans = await tx.ratePlan.findMany({ where: { propertyId: c.propertyId }, select: { id: true, name: true } });
          const rt = new Map(names.map((n) => [n.id, n.name]));
          const rp = new Map(plans.map((n) => [n.id, n.name]));
          const pending = count('PENDING');
          const running = count('RUNNING');
          return {
            connectionId: c.id,
            propertyId: c.propertyId,
            propertyName: c.property.name,
            channelName: c.channelName,
            channelPropertyId: c.channelPropertyId,
            environment: c.environment,
            connectionStatus: c.status,
            health: c.status !== 'ACTIVE' ? 'not_active' : failed24h > 0 || c.reservationsPollFailures >= 3 ? 'attention' : pending + running > 0 ? 'syncing' : 'in_sync',
            jobs: { pending, running, succeeded24h, failed24h, lastSuccessAt: lastSuccess?.finishedAt ?? null },
            reservations: { lastPolledAt: c.reservationsPolledAt, pollError: c.reservationsPollError, consecutiveFailures: c.reservationsPollFailures, summaryImportedAt: c.summaryImportedAt, lastReceivedAt: lastReservation?.receivedAt ?? null, total: reservationCount },
            openDiscrepancies,
            recentJobs: recent.map((j) => ({
              id: j.id,
              kind: j.kind,
              status: j.status,
              roomTypeName: j.roomTypeId ? (rt.get(j.roomTypeId) ?? null) : null,
              ratePlanName: j.ratePlanId ? (rp.get(j.ratePlanId) ?? null) : null,
              dateFrom: fromDbDate(j.dateFrom),
              dateTo: fromDbDate(j.dateTo),
              attempts: j.attempts,
              callsMade: j.callsMade,
              lastError: j.lastError,
              nextAttemptAt: j.status === 'PENDING' ? j.nextAttemptAt : null,
              createdAt: j.createdAt,
              finishedAt: j.finishedAt,
            })),
          };
        }),
      );
    });
    sendData(res, data);
  });

  r.post('/sync-jobs/:jobId/retry', requireOrgPermission('channel.manage'), async (req, res) => {
    const orgId = req.org!.organizationId;
    const jobId = uuidParam(req.params['jobId']);
    await withTenant(db, orgId, async (tx) => {
      const exists = await tx.syncJob.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!exists) throw new AppError(404, 'NOT_FOUND', 'Sync job not found');
      if (!(await retryFailedJob(tx, jobId, req.auth!.user.id))) throw new AppError(409, 'NOT_RETRYABLE', 'Only failed updates of an active connection with future dates can be retried.');
      await audit.record({ action: 'sync.job_retried', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'sync_job', entityId: jobId, ...requestMeta(req) }, tx);
    });
    sendData(res, { queued: true });
  });

  r.get('/discrepancies', requireOrgPermission('property.read'), async (req, res) => {
    const q = parseQuery(z.object({ propertyId: optionalUuid, status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }), req);
    sendData(res, await discrepancies.list(req.org!.organizationId, q));
  });

  r.post('/discrepancies/:discrepancyId/:decision', requireOrgPermission('channel.manage'), async (req, res) => {
    const decision = req.params['decision'];
    if (decision !== 'resolve' && decision !== 'ignore' && decision !== 'reopen') throw new AppError(404, 'NOT_FOUND', 'Not found');
    const body = parseBody(DecisionBody, req);
    sendData(res, await discrepancies.decide(req.org!.organizationId, uuidParam(req.params['discrepancyId']), decision, body.note ?? null, req.auth!.user, requestMeta(req)));
  });

  return r;
}

/** Mounted inside the admin router. Support never sees guest data, even with a grant. */
export function adminReservationsRouter(deps: { db: Database; audit: AuditService; support: SupportAccessService; reservations: ReservationService }): Router {
  const r = Router();

  r.get('/support-access/:requestId/reservations', requirePlatformPermission('admin.support.request'), async (req, res) => {
    const grant = await deps.support.assertActiveGrant(req.auth!.user.id, uuidParam(req.params['requestId']));
    const list = await deps.reservations.adminList(grant.organizationId);
    await deps.audit.record({
      action: 'support.data_accessed',
      organizationId: grant.organizationId,
      actorUserId: req.auth!.user.id,
      entityType: 'support_access_request',
      entityId: req.params['requestId'] as string,
      metadata: { resource: 'reservations', count: list.length },
      ...requestMeta(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, list, 200, { accessExpiresAt: grant.expiresAt.toISOString(), guestDetails: 'not available to platform staff' });
  });

  r.get('/integrations/zodomus/sync', requirePlatformPermission('admin.integration.read'), async (_req, res) => {
    const data = await withSystem(deps.db, async (tx) => {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [byStatus, failed24h, oldestPending, connections, pollFailing, openByKind] = await Promise.all([
        tx.syncJob.groupBy({ by: ['status'], where: { status: { in: ['PENDING', 'RUNNING'] } }, _count: { _all: true } }),
        tx.syncJob.count({ where: { status: 'FAILED', finishedAt: { gte: since } } }),
        tx.syncJob.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
        tx.channelConnection.groupBy({ by: ['status'], _count: { _all: true } }),
        tx.channelConnection.count({ where: { status: 'ACTIVE', reservationsPollFailures: { gte: 3 } } }),
        tx.discrepancy.groupBy({ by: ['kind'], where: { status: 'OPEN' }, _count: { _all: true } }),
      ]);
      return {
        jobs: { ...Object.fromEntries(byStatus.map((b) => [b.status.toLowerCase(), b._count._all])), failed24h, oldestPendingAt: oldestPending?.createdAt ?? null },
        connections: Object.fromEntries(connections.map((c) => [c.status.toLowerCase(), c._count._all])),
        reservationPollingFailing: pollFailing,
        openDiscrepancies: Object.fromEntries(openByKind.map((k) => [k.kind, k._count._all])),
      };
    });
    sendData(res, data);
  });

  return r;
}
