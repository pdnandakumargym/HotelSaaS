import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant } from '../../infrastructure/db/tenant.js';
import { requireAuth, requireRecentAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import type { InvitationService } from '../invitations/invitation.service.js';
import { propertiesRouter } from '../properties/properties.routes.js';
import { channelOptionsRouter, connectionsRouter, orgChannelsRouter } from '../channels/channels.routes.js';
import type { ChannelConnectionService } from '../channels/connection.service.js';
import { ratesRouter } from '../rates/rates.routes.js';
import type { IntegrationService } from '../channels/integration.service.js';
import { currency } from '../properties/properties.schemas.js';
import { getSubscription, usage } from '../subscriptions/plan-limits.js';
import type { SupportAccessService } from '../support/support-access.service.js';

const Pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const SecurityPolicyBody = z.object({ twoFactorRequired: z.boolean() });
const UpdateOrgBody = z.object({ name: z.string().trim().min(2).max(160), defaultCurrency: currency }).partial().strict();
const Role = z.enum(['ORG_OWNER', 'PROPERTY_MANAGER', 'PROPERTY_STAFF', 'READ_ONLY']);
const InviteBody = z.object({ email: z.string().trim().pipe(z.email().max(254)), role: Role }).strict();
const RoleBody = z.object({ role: Role }).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for (const [method, path, summary] of [
  ['get', '/organizations', 'Organizations I belong to'],
  ['get', '/organizations/{orgId}', 'Organization details (member only)'],
  ['patch', '/organizations/{orgId}', 'Update name / default currency (owner)'],
  ['get', '/organizations/{orgId}/members', 'Members (member.read)'],
  ['patch', '/organizations/{orgId}/members/{membershipId}', 'Change a member role (owner; last owner protected)'],
  ['delete', '/organizations/{orgId}/members/{membershipId}', 'Remove a member, or leave (self)'],
  ['get', '/organizations/{orgId}/invitations', 'Pending invitations (owner)'],
  ['post', '/organizations/{orgId}/invitations', 'Invite by email (owner, plan user limit)'],
  ['post', '/organizations/{orgId}/invitations/{invitationId}/resend', 'Send a fresh invitation link'],
  ['delete', '/organizations/{orgId}/invitations/{invitationId}', 'Revoke an invitation'],
  ['get', '/organizations/{orgId}/subscription', 'Plan, status, usage and limits'],
  ['patch', '/organizations/{orgId}/security', 'Set the organization 2FA policy (owner, recent auth)'],
  ['get', '/organizations/{orgId}/support-access', 'Support access requests for this organization (owner)'],
  ['post', '/organizations/{orgId}/support-access/{requestId}/{decision}', 'Approve, deny or revoke support access (owner, recent auth)'],
  ['get', '/organizations/{orgId}/audit-events', 'Audit events of an organization (audit.read)'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Organizations'], summary, responses: { 200: { description: 'OK' }, 404: { description: 'Not found or not a member' } } });
}

function id(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !UUID.test(v)) throw new NotFoundError();
  return v;
}

/**
 * Tenant routes. Every handler runs inside withTenant(), so PostgreSQL row-level security
 * restricts queries to the organization the caller was authorized for.
 */
export function organizationsRouter(deps: { db: Database; config: AppConfig; audit: AuditService; invitations: InvitationService; support: SupportAccessService; integrations: IntegrationService; connections: ChannelConnectionService }): Router {
  const { db, config, audit, invitations, support } = deps;
  const r = Router();
  r.use(requireAuth());
  const recent = requireRecentAuth(config);

  r.use('/:orgId/properties', propertiesRouter({ db, audit }));
  r.use('/:orgId/channels', orgChannelsRouter({ db, integrations: deps.integrations, connections: deps.connections }));
  r.use('/:orgId/channel-options', channelOptionsRouter(deps.connections));
  r.use('/:orgId/properties/:propertyId/channel-connections', connectionsRouter({ connections: deps.connections }));
  r.use('/:orgId/properties/:propertyId', ratesRouter({ db, audit }));

  r.get('/', (req, res) => {
    sendData(
      res,
      req.auth!.user.memberships.map((m) => ({
        id: m.organizationId,
        name: m.organizationName,
        role: m.role,
        status: m.organizationStatus,
        twoFactorRequired: m.twoFactorRequired,
      })),
    );
  });

  r.get('/:orgId', requireOrgPermission('org.read'), async (req, res) => {
    const org = await withTenant(db, req.org!.organizationId, (tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: req.org!.organizationId },
        select: { id: true, name: true, slug: true, status: true, defaultCurrency: true, twoFactorRequired: true, createdAt: true },
      }),
    );
    sendData(res, { ...org, myRole: req.org!.role, myPermissions: req.org!.permissions });
  });

  r.patch('/:orgId', requireOrgPermission('org.update'), async (req, res) => {
    const body = parseBody(UpdateOrgBody, req);
    const orgId = req.org!.organizationId;
    const updated = await withTenant(db, orgId, async (tx) => {
      const org = await tx.organization.update({ where: { id: orgId }, data: body, select: { id: true, name: true, defaultCurrency: true } });
      await audit.record({ action: 'org.updated', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'organization', entityId: orgId, metadata: { fields: Object.keys(body) }, ...requestMeta(req) }, tx);
      return org;
    });
    sendData(res, updated);
  });

  // --- members --------------------------------------------------------------------

  r.get('/:orgId/members', requireOrgPermission('member.read'), async (req, res) => {
    const members = await withTenant(db, req.org!.organizationId, (tx) =>
      tx.organizationMembership.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, createdAt: true, user: { select: { id: true, displayName: true, email: true, totpEnabledAt: true, lastLoginAt: true } } },
      }),
    );
    sendData(
      res,
      members.map((m) => ({
        membershipId: m.id,
        role: m.role,
        joinedAt: m.createdAt,
        userId: m.user.id,
        displayName: m.user.displayName,
        email: m.user.email,
        twoFactorEnabled: !!m.user.totpEnabledAt,
        lastLoginAt: m.user.lastLoginAt,
        isMe: m.user.id === req.auth!.user.id,
      })),
    );
  });

  r.patch('/:orgId/members/:membershipId', requireOrgPermission('member.manage'), async (req, res) => {
    const membershipId = id(req, 'membershipId');
    const { role } = parseBody(RoleBody, req);
    const orgId = req.org!.organizationId;
    const updated = await withTenant(db, orgId, async (tx) => {
      const m = await tx.organizationMembership.findUnique({ where: { id: membershipId } });
      if (!m) throw new NotFoundError('Member not found');
      if (m.role === 'ORG_OWNER' && role !== 'ORG_OWNER' && (await tx.organizationMembership.count({ where: { role: 'ORG_OWNER' } })) <= 1) {
        throw new AppError(409, 'LAST_OWNER', 'An organization needs at least one owner. Make someone else an owner first.');
      }
      const u = await tx.organizationMembership.update({ where: { id: membershipId }, data: { role }, select: { id: true, role: true, userId: true } });
      await audit.record(
        { action: 'org.member.role_changed', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'membership', entityId: membershipId, metadata: { from: m.role, to: role, userId: m.userId }, ...requestMeta(req) },
        tx,
      );
      return u;
    });
    sendData(res, updated);
  });

  r.delete('/:orgId/members/:membershipId', requireOrgPermission('org.read'), async (req, res) => {
    const membershipId = id(req, 'membershipId');
    const orgId = req.org!.organizationId;
    await withTenant(db, orgId, async (tx) => {
      const m = await tx.organizationMembership.findUnique({ where: { id: membershipId } });
      if (!m) throw new NotFoundError('Member not found');
      const self = m.userId === req.auth!.user.id;
      if (!self && !req.org!.permissions.includes('member.manage')) throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.');
      if (m.role === 'ORG_OWNER' && (await tx.organizationMembership.count({ where: { role: 'ORG_OWNER' } })) <= 1) {
        throw new AppError(409, 'LAST_OWNER', 'An organization needs at least one owner. Make someone else an owner first.');
      }
      await tx.organizationMembership.delete({ where: { id: membershipId } });
      await audit.record(
        { action: self ? 'org.member.left' : 'org.member.removed', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'membership', entityId: membershipId, metadata: { userId: m.userId, role: m.role }, ...requestMeta(req) },
        tx,
      );
    });
    sendData(res, { status: 'removed' });
  });

  // --- invitations ---------------------------------------------------------------------

  r.get('/:orgId/invitations', requireOrgPermission('member.manage'), async (req, res) => {
    const list = await withTenant(db, req.org!.organizationId, (tx) =>
      tx.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    );
    sendData(
      res,
      list.map((i) => ({ ...i, expired: i.expiresAt.getTime() <= Date.now() })),
    );
  });

  r.post('/:orgId/invitations', requireOrgPermission('member.manage'), async (req, res) => {
    const body = parseBody(InviteBody, req);
    const inv = await invitations.create(req.org!.organizationId, req.auth!.user, body, requestMeta(req));
    sendData(res, inv, 201);
  });

  r.post('/:orgId/invitations/:invitationId/resend', requireOrgPermission('member.manage'), async (req, res) => {
    await invitations.resend(req.org!.organizationId, id(req, 'invitationId'), req.auth!.user, requestMeta(req));
    sendData(res, { status: 'sent' });
  });

  r.delete('/:orgId/invitations/:invitationId', requireOrgPermission('member.manage'), async (req, res) => {
    await invitations.revoke(req.org!.organizationId, id(req, 'invitationId'), req.auth!.user.id, requestMeta(req));
    sendData(res, { status: 'revoked' });
  });

  // --- subscription ------------------------------------------------------------------------

  r.get('/:orgId/subscription', requireOrgPermission('org.read'), async (req, res) => {
    const orgId = req.org!.organizationId;
    const [sub, u] = await withTenant(db, orgId, (tx) => Promise.all([getSubscription(tx, orgId), usage(tx, orgId)]));
    sendData(res, { ...sub, usage: u, canManageBilling: req.org!.permissions.includes('billing.manage') });
  });

  // --- security & support access -----------------------------------------------------------

  r.patch('/:orgId/security', requireOrgPermission('org.security.manage'), recent, async (req, res) => {
    const { twoFactorRequired } = parseBody(SecurityPolicyBody, req);
    const orgId = req.org!.organizationId;
    const updated = await withTenant(db, orgId, async (tx) => {
      const org = await tx.organization.update({ where: { id: orgId }, data: { twoFactorRequired }, select: { id: true, twoFactorRequired: true } });
      await audit.record(
        { action: 'org.security_policy.updated', organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'organization', entityId: orgId, metadata: { twoFactorRequired }, ...requestMeta(req) },
        tx,
      );
      return org;
    });
    sendData(res, updated);
  });

  r.get('/:orgId/support-access', requireOrgPermission('org.security.manage'), async (req, res) => {
    const list = await support.listForOrg(req.org!.organizationId);
    const now = Date.now();
    sendData(
      res,
      list.map((s) => ({ ...s, active: s.status === 'APPROVED' && !!s.expiresAt && s.expiresAt.getTime() > now })),
    );
  });

  // Granting access is sensitive (recent auth); denying or revoking is protective.
  for (const decision of ['approve', 'deny', 'revoke'] as const) {
    const guards = decision === 'approve' ? [requireOrgPermission('org.security.manage'), recent] : [requireOrgPermission('org.security.manage')];
    r.post(`/:orgId/support-access/:requestId/${decision}`, ...guards, async (req, res) => {
      const updated = await support.decide(req.org!.organizationId, id(req, 'requestId'), req.auth!.user, decision, requestMeta(req));
      sendData(res, updated);
    });
  }

  r.get('/:orgId/audit-events', requireOrgPermission('audit.read'), async (req, res) => {
    const { page, pageSize } = parseQuery(Pagination, req);
    const [items, total] = await withTenant(db, req.org!.organizationId, (tx) =>
      Promise.all([
        tx.auditEvent.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, action: true, actorUserId: true, actorType: true, entityType: true, entityId: true, createdAt: true, ipAddress: true, metadata: true },
        }),
        tx.auditEvent.count(),
      ]),
    );
    sendData(res, items, 200, { page, pageSize, total });
  });

  return r;
}
