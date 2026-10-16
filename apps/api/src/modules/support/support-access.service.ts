import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import type { Mailer } from '../../infrastructure/mail/mailer.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';

/**
 * Support access: platform staff never see a tenant's data by default. They request access
 * with a reason and a duration; an organization owner approves it; access is read-only,
 * expires automatically, can be revoked at any time, and every read is audited.
 */
export class SupportAccessService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  async request(admin: { id: string; displayName: string }, input: { organizationId: string; reason: string; durationMinutes: number }, meta: RequestMeta) {
    const { org, owners, created } = await withSystem(this.db, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true } });
      if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
      const open = await tx.supportAccessRequest.count({
        where: { organizationId: org.id, requestedById: admin.id, OR: [{ status: 'PENDING' }, { status: 'APPROVED', expiresAt: { gt: new Date() } }] },
      });
      if (open > 0) throw new AppError(409, 'REQUEST_ALREADY_OPEN', 'You already have a pending or active request for this organization.');
      const created = await tx.supportAccessRequest.create({
        data: { organizationId: org.id, requestedById: admin.id, reason: input.reason.trim(), durationMinutes: input.durationMinutes },
      });
      const owners = await tx.organizationMembership.findMany({ where: { organizationId: org.id, role: 'ORG_OWNER' }, select: { user: { select: { email: true } } } });
      await this.audit.record(
        { action: 'support.access.requested', organizationId: org.id, actorUserId: admin.id, entityType: 'support_access_request', entityId: created.id, metadata: { durationMinutes: input.durationMinutes }, ...meta },
        tx,
      );
      return { org, owners, created };
    });
    for (const o of owners) {
      try {
        await this.mailer.send({
          to: o.user.email,
          subject: `${this.config.appName} support is asking for temporary access to ${org.name}`,
          text: `${admin.displayName} from ${this.config.appName} support asked for read-only access to ${org.name} for ${input.durationMinutes} minutes.\n\nReason: ${input.reason}\n\nApprove or deny it under Profile & Security > Support access:\n${this.config.appBaseUrl}/app/settings\n\nNothing is shared unless you approve. You can revoke access at any time.`,
        });
      } catch {
        // best effort
      }
    }
    return created;
  }

  listForAdmin(adminId: string, all: boolean) {
    return withSystem(this.db, (tx) =>
      tx.supportAccessRequest.findMany({
        where: all ? {} : { requestedById: adminId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { organization: { select: { name: true } } },
      }),
    );
  }

  listForOrg(organizationId: string) {
    return withTenant(this.db, organizationId, (tx) => tx.supportAccessRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
  }

  async decide(organizationId: string, requestId: string, owner: { id: string }, decision: 'approve' | 'deny' | 'revoke', meta: RequestMeta) {
    return withTenant(this.db, organizationId, async (tx) => {
      const r = await tx.supportAccessRequest.findUnique({ where: { id: requestId } });
      if (!r) throw new AppError(404, 'NOT_FOUND', 'Request not found');
      const now = new Date();
      if (decision === 'revoke') {
        if (r.status !== 'APPROVED' || !r.expiresAt || r.expiresAt <= now) throw new AppError(409, 'NOT_ACTIVE', 'This access is not active.');
      } else if (r.status !== 'PENDING') {
        throw new AppError(409, 'ALREADY_DECIDED', 'This request was already decided.');
      }
      const data =
        decision === 'approve'
          ? { status: 'APPROVED' as const, decidedById: owner.id, decidedAt: now, expiresAt: new Date(now.getTime() + r.durationMinutes * 60_000) }
          : decision === 'deny'
            ? { status: 'DENIED' as const, decidedById: owner.id, decidedAt: now }
            : { status: 'REVOKED' as const, decidedById: owner.id, decidedAt: now, expiresAt: now };
      const updated = await tx.supportAccessRequest.update({ where: { id: r.id }, data });
      await this.audit.record(
        { action: `support.access.${decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'revoked'}`, organizationId, actorUserId: owner.id, entityType: 'support_access_request', entityId: r.id, ...meta },
        tx,
      );
      return updated;
    });
  }

  /** Returns the organization id if this admin holds an approved, unexpired grant; otherwise 403. */
  async assertActiveGrant(adminId: string, requestId: string): Promise<{ organizationId: string; expiresAt: Date }> {
    const r = await withSystem(this.db, (tx) => tx.supportAccessRequest.findUnique({ where: { id: requestId } }));
    if (!r || r.requestedById !== adminId || r.status !== 'APPROVED' || !r.expiresAt || r.expiresAt <= new Date()) {
      throw new AppError(403, 'SUPPORT_ACCESS_REQUIRED', 'You need an approved, unexpired support access grant from the organization owner.');
    }
    return { organizationId: r.organizationId, expiresAt: r.expiresAt };
  }
}
