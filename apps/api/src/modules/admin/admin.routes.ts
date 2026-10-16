import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import { requireAuth, requirePlatformPermission, requireRecentAuth } from '../../middleware/auth.js';
import { registry } from '../../openapi/registry.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import { getSubscription, usage } from '../subscriptions/plan-limits.js';
import type { SupportAccessService } from '../support/support-access.service.js';
import { adminIntegrationsRouter } from '../channels/channels.routes.js';
import type { IntegrationService } from '../channels/integration.service.js';

const OrgStatusBody = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().min(5).max(500) }).strict();
const SubscriptionBody = z
  .object({ planCode: z.string().trim().toUpperCase().max(20), status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED']).optional() })
  .strict();
const SupportRequestBody = z
  .object({ organizationId: z.uuid(), reason: z.string().trim().min(10).max(500), durationMinutes: z.number().int().min(15).max(480) })
  .strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return v;
}

const Pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
});

for (const [method, path, summary] of [
  ['get', '/admin/overview', 'Platform counts'],
  ['get', '/admin/organizations', 'All organizations (no guest data)'],
  ['get', '/admin/users', 'All users (security-relevant fields only)'],
  ['post', '/admin/users/{userId}/unlock', 'Clear a temporary lockout (super admin, recent auth)'],
  ['get', '/admin/audit-events', 'Platform audit log'],
  ['get', '/admin/organizations/{orgId}', 'Organization detail: subscription, usage, members (no guest data)'],
  ['patch', '/admin/organizations/{orgId}/status', 'Suspend or reactivate an organization (recent auth)'],
  ['patch', '/admin/organizations/{orgId}/subscription', 'Change plan or subscription status (recent auth)'],
  ['get', '/admin/properties', 'All properties (business data only)'],
  ['get', '/admin/plans', 'Plan catalog'],
  ['post', '/admin/support-access', 'Request owner-approved, time-boxed support access'],
  ['get', '/admin/support-access', 'My support access requests (all with audit permission)'],
  ['get', '/admin/support-access/{requestId}/properties', 'Read-only tenant view under an active grant (audited)'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Admin'], summary, responses: { 200: { description: 'OK' }, 403: { description: 'Not a platform admin / 2FA missing' } } });
}

/**
 * Platform administration. Requires a platform role AND a verified second factor.
 * These endpoints deliberately expose no guest personal data; support access to a
 * tenant's guest data will need an explicit, time-boxed, audited grant (Milestone 3).
 */
export function adminRouter(deps: { db: Database; config: AppConfig; audit: AuditService; support: SupportAccessService; integrations: IntegrationService }): Router {
  const { db, config, audit, support } = deps;
  const r = Router();
  r.use(requireAuth(), requirePlatformPermission('admin.access'));
  r.use('/integrations', adminIntegrationsRouter(deps.integrations));

  r.get('/overview', async (_req, res) => {
    const [organizations, properties, users, lockedUsers] = await withSystem(db, (tx) =>
      Promise.all([
        tx.organization.count(),
        tx.property.count(),
        tx.user.count(),
        tx.user.count({ where: { lockedUntil: { gt: new Date() } } }),
      ]),
    );
    sendData(res, { organizations, properties, users, lockedUsers });
  });

  r.get('/organizations', requirePlatformPermission('admin.org.read'), async (req, res) => {
    const { page, pageSize, q } = parseQuery(Pagination, req);
    const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q.toLowerCase() } }] } : {};
    const [items, total] = await withSystem(db, (tx) =>
      Promise.all([
        tx.organization.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, name: true, slug: true, status: true, twoFactorRequired: true, createdAt: true, _count: { select: { properties: true, memberships: true } } },
        }),
        tx.organization.count({ where }),
      ]),
    );
    sendData(
      res,
      items.map(({ _count, ...o }) => ({ ...o, propertyCount: _count.properties, memberCount: _count.memberships })),
      200,
      { page, pageSize, total },
    );
  });

  r.get('/users', requirePlatformPermission('admin.user.read'), async (req, res) => {
    const { page, pageSize, q } = parseQuery(Pagination, req);
    const where = q ? { OR: [{ email: { contains: q.toLowerCase() } }, { displayName: { contains: q, mode: 'insensitive' as const } }] } : {};
    const [items, total] = await withSystem(db, (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            platformRole: true,
            emailVerifiedAt: true,
            totpEnabledAt: true,
            lastLoginAt: true,
            lockedUntil: true,
            createdAt: true,
            _count: { select: { memberships: true } },
          },
        }),
        tx.user.count({ where }),
      ]),
    );
    const now = Date.now();
    sendData(
      res,
      items.map(({ _count, totpEnabledAt, lockedUntil, ...u }) => ({
        ...u,
        twoFactorEnabled: !!totpEnabledAt,
        locked: !!lockedUntil && lockedUntil.getTime() > now,
        organizationCount: _count.memberships,
      })),
      200,
      { page, pageSize, total },
    );
  });

  r.post('/users/:userId/unlock', requirePlatformPermission('admin.user.manage'), requireRecentAuth(config), async (req, res) => {
    const userId = req.params['userId'];
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const updated = await withSystem(db, (tx) => tx.user.updateMany({ where: { id: userId }, data: { lockedUntil: null, failedLoginCount: 0 } }));
    if (updated.count === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
    await audit.record({ action: 'admin.user.unlocked', actorUserId: req.auth!.user.id, entityType: 'user', entityId: userId, ...requestMeta(req) });
    sendData(res, { status: 'unlocked' });
  });

  r.get('/audit-events', requirePlatformPermission('admin.audit.read'), async (req, res) => {
    const { page, pageSize, q } = parseQuery(Pagination, req);
    const where = q ? { action: { startsWith: q } } : {};
    const [items, total] = await withSystem(db, (tx) =>
      Promise.all([
        tx.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
        tx.auditEvent.count({ where }),
      ]),
    );
    sendData(res, items, 200, { page, pageSize, total });
  });

  // --- organizations: detail, suspension, subscription ----------------------------------

  r.get('/organizations/:orgId', requirePlatformPermission('admin.org.read'), async (req, res) => {
    const orgId = uuidParam(req.params['orgId']);
    const data = await withSystem(db, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true, status: true, defaultCurrency: true, twoFactorRequired: true, createdAt: true },
      });
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
      const [subscription, use, members, properties, recent] = await Promise.all([
        getSubscription(tx, orgId),
        usage(tx, orgId),
        tx.organizationMembership.findMany({
          where: { organizationId: orgId },
          orderBy: { createdAt: 'asc' },
          select: { role: true, createdAt: true, user: { select: { id: true, displayName: true, email: true, totpEnabledAt: true, lastLoginAt: true } } },
        }),
        tx.property.findMany({
          where: { organizationId: orgId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, propertyType: true, status: true, city: true, countryCode: true, _count: { select: { roomTypes: true, rooms: true } } },
        }),
        tx.auditEvent.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, action: true, actorType: true, createdAt: true } }),
      ]);
      return { org, subscription, usage: use, members, properties, recentEvents: recent };
    });
    sendData(res, {
      ...data.org,
      subscription: data.subscription,
      usage: data.usage,
      members: data.members.map((m) => ({ role: m.role, joinedAt: m.createdAt, userId: m.user.id, displayName: m.user.displayName, email: m.user.email, twoFactorEnabled: !!m.user.totpEnabledAt, lastLoginAt: m.user.lastLoginAt })),
      properties: data.properties.map(({ _count, ...p }) => ({ ...p, roomTypeCount: _count.roomTypes, roomCount: _count.rooms })),
      recentEvents: data.recentEvents,
    });
  });

  r.patch('/organizations/:orgId/status', requirePlatformPermission('admin.org.manage'), requireRecentAuth(config), async (req, res) => {
    const orgId = uuidParam(req.params['orgId']);
    const { status, reason } = parseBody(OrgStatusBody, req);
    const updated = await withSystem(db, async (tx) => {
      const exists = await tx.organization.findUnique({ where: { id: orgId }, select: { status: true } });
      if (!exists) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
      const org = await tx.organization.update({ where: { id: orgId }, data: { status }, select: { id: true, status: true } });
      await audit.record(
        { action: status === 'SUSPENDED' ? 'admin.org.suspended' : 'admin.org.reactivated', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'organization', entityId: orgId, metadata: { reason, from: exists.status }, ...requestMeta(req) },
        tx,
      );
      return org;
    });
    sendData(res, updated);
  });

  r.patch('/organizations/:orgId/subscription', requirePlatformPermission('admin.billing.manage'), requireRecentAuth(config), async (req, res) => {
    const orgId = uuidParam(req.params['orgId']);
    const body = parseBody(SubscriptionBody, req);
    const updated = await withSystem(db, async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code: body.planCode } });
      if (!plan || !plan.isActive) throw new AppError(400, 'UNKNOWN_PLAN', 'Unknown or inactive plan');
      if (!(await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
      const before = await tx.subscription.findUnique({ where: { organizationId: orgId }, include: { plan: { select: { code: true } } } });
      const status = body.status ?? 'ACTIVE';
      const sub = await tx.subscription.upsert({
        where: { organizationId: orgId },
        update: { planId: plan.id, status, ...(status !== 'TRIALING' ? { trialEndsAt: null } : {}) },
        create: { organizationId: orgId, planId: plan.id, status },
      });
      await audit.record(
        { action: 'admin.subscription.changed', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'subscription', entityId: sub.id, metadata: { from: before?.plan.code ?? null, to: plan.code, status }, ...requestMeta(req) },
        tx,
      );
      return { planCode: plan.code, status: sub.status };
    });
    sendData(res, updated);
  });

  r.get('/properties', requirePlatformPermission('admin.org.read'), async (req, res) => {
    const { page, pageSize, q } = parseQuery(Pagination, req);
    const where = q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { city: { contains: q, mode: 'insensitive' as const } }] } : {};
    const [items, total] = await withSystem(db, (tx) =>
      Promise.all([
        tx.property.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            name: true,
            propertyType: true,
            status: true,
            city: true,
            countryCode: true,
            createdAt: true,
            organization: { select: { id: true, name: true } },
            _count: { select: { roomTypes: true, rooms: true } },
          },
        }),
        tx.property.count({ where }),
      ]),
    );
    sendData(
      res,
      items.map(({ _count, ...p }) => ({ ...p, roomTypeCount: _count.roomTypes, roomCount: _count.rooms })),
      200,
      { page, pageSize, total },
    );
  });

  r.get('/plans', async (_req, res) => {
    sendData(res, await withSystem(db, (tx) => tx.plan.findMany({ orderBy: { sortOrder: 'asc' } })));
  });

  // --- support access -----------------------------------------------------------------------

  r.post('/support-access', requirePlatformPermission('admin.support.request'), async (req, res) => {
    const body = parseBody(SupportRequestBody, req);
    const created = await support.request(req.auth!.user, body, requestMeta(req));
    sendData(res, created, 201);
  });

  r.get('/support-access', requirePlatformPermission('admin.support.request'), async (req, res) => {
    const all = req.query['all'] === 'true' && req.auth!.user.platformRole === 'PLATFORM_SUPER_ADMIN';
    const list = await support.listForAdmin(req.auth!.user.id, all);
    const now = Date.now();
    sendData(
      res,
      list.map((s) => ({ ...s, organizationName: s.organization.name, active: s.status === 'APPROVED' && !!s.expiresAt && s.expiresAt.getTime() > now })),
    );
  });

  r.get('/support-access/:requestId/properties', requirePlatformPermission('admin.support.request'), async (req, res) => {
    const grant = await support.assertActiveGrant(req.auth!.user.id, uuidParam(req.params['requestId']));
    // Read through the tenant's RLS context, exactly like the tenant would.
    const properties = await withTenant(db, grant.organizationId, async (tx) => {
      const list = await tx.property.findMany({
        orderBy: { name: 'asc' },
        include: { roomTypes: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, code: true, maxOccupancy: true, status: true, _count: { select: { rooms: true } } } } },
      });
      await audit.record(
        { action: 'support.data_accessed', organizationId: grant.organizationId, actorUserId: req.auth!.user.id, entityType: 'support_access_request', entityId: req.params['requestId'] as string, metadata: { resource: 'properties', count: list.length }, ...requestMeta(req) },
        tx,
      );
      return list;
    });
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, properties.map((p) => ({ ...p, latitude: p.latitude?.toNumber() ?? null, longitude: p.longitude?.toNumber() ?? null })), 200, { accessExpiresAt: grant.expiresAt.toISOString() });
  });

  return r;
}
