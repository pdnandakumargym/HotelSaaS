import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import type { Mailer } from '../../infrastructure/mail/mailer.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { OrganizationRole } from '../../generated/prisma/enums.js';
import type { AuditService } from '../audit/audit.service.js';
import { normalizeEmail, type RequestMeta } from '../auth/auth.service.js';
import { passwordProblems, type PasswordHasher } from '../auth/password.js';
import type { IssuedSession, SessionService } from '../auth/session.service.js';
import { assertCanAddUser } from '../subscriptions/plan-limits.js';

const INVITE_TTL_MS = 7 * 24 * 3_600_000;

const ROLE_LABELS: Record<OrganizationRole, string> = {
  ORG_OWNER: 'Owner',
  PROPERTY_MANAGER: 'Property manager',
  PROPERTY_STAFF: 'Property staff',
  READ_ONLY: 'Read-only viewer',
};

function invalidInvite(): AppError {
  return new AppError(400, 'INVALID_OR_EXPIRED_INVITATION', 'This invitation is invalid, expired or already used. Ask for a new one.');
}

/** Invitations: created by organization owners, accepted by the invited email address only. */
export class InvitationService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
  ) {}

  async create(organizationId: string, actor: { id: string; displayName: string }, input: { email: string; role: OrganizationRole }, meta: RequestMeta) {
    const email = normalizeEmail(input.email);
    const token = randomToken(32);
    const result = await withTenant(this.db, organizationId, async (tx) => {
      const existingMember = await tx.organizationMembership.findFirst({ where: { user: { email } }, select: { id: true } });
      if (existingMember) throw new AppError(409, 'ALREADY_MEMBER', 'This person is already a member of the organization.');
      // Only one active invitation per address: a new invite replaces the old link.
      await tx.invitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await assertCanAddUser(tx, organizationId);
      const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
      const invitation = await tx.invitation.create({
        data: { organizationId, email, role: input.role, tokenHash: sha256Hex(token), invitedById: actor.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      });
      await this.audit.record(
        { action: 'org.invitation.created', organizationId, actorUserId: actor.id, entityType: 'invitation', entityId: invitation.id, metadata: { role: input.role }, ...meta },
        tx,
      );
      return { invitation, orgName: org.name };
    });
    await this.sendInvite(email, result.orgName, actor.displayName, input.role, token);
    return result.invitation;
  }

  async resend(organizationId: string, invitationId: string, actor: { id: string; displayName: string }, meta: RequestMeta) {
    const token = randomToken(32);
    const res = await withTenant(this.db, organizationId, async (tx) => {
      const inv = await tx.invitation.findFirst({ where: { id: invitationId, acceptedAt: null, revokedAt: null } });
      if (!inv) throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
      await tx.invitation.update({ where: { id: inv.id }, data: { tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) } });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } });
      await this.audit.record({ action: 'org.invitation.resent', organizationId, actorUserId: actor.id, entityType: 'invitation', entityId: inv.id, ...meta }, tx);
      return { inv, orgName: org.name };
    });
    await this.sendInvite(res.inv.email, res.orgName, actor.displayName, res.inv.role, token);
  }

  async revoke(organizationId: string, invitationId: string, actorId: string, meta: RequestMeta): Promise<void> {
    await withTenant(this.db, organizationId, async (tx) => {
      const updated = await tx.invitation.updateMany({ where: { id: invitationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (updated.count === 0) throw new AppError(404, 'NOT_FOUND', 'Invitation not found');
      await this.audit.record({ action: 'org.invitation.revoked', organizationId, actorUserId: actorId, entityType: 'invitation', entityId: invitationId, ...meta }, tx);
    });
  }

  /** What the invite link is for. Only the holder of the token (sent to that address) can see this. */
  async preview(token: string) {
    const inv = await this.findValid(token);
    const accountExists = await withSystem(this.db, (tx) => tx.user.count({ where: { email: inv.email } }));
    return { organizationName: inv.organization.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, accountExists: accountExists > 0 };
  }

  /** Signed-in user accepts. The account email must match the invited address. */
  async accept(token: string, user: { id: string; email: string }, meta: RequestMeta): Promise<{ organizationId: string }> {
    const inv = await this.findValid(token);
    if (inv.email !== user.email) {
      throw new AppError(403, 'INVITATION_EMAIL_MISMATCH', `This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);
    }
    await withSystem(this.db, async (tx) => {
      const consumed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (consumed.count !== 1) throw invalidInvite();
      const exists = await tx.organizationMembership.findUnique({ where: { organizationId_userId: { organizationId: inv.organizationId, userId: user.id } } });
      if (exists) throw new AppError(409, 'ALREADY_MEMBER', 'You are already a member of this organization.');
      await tx.organizationMembership.create({ data: { organizationId: inv.organizationId, userId: user.id, role: inv.role } });
      await this.audit.record(
        { action: 'org.invitation.accepted', organizationId: inv.organizationId, actorUserId: user.id, entityType: 'invitation', entityId: inv.id, metadata: { role: inv.role }, ...meta },
        tx,
      );
    });
    return { organizationId: inv.organizationId };
  }

  /**
   * New person accepts by creating an account. The invite link proved control of the mailbox,
   * so the email counts as verified. Returns a signed-in session.
   */
  async registerAndAccept(token: string, input: { displayName: string; password: string }, meta: RequestMeta): Promise<IssuedSession> {
    const inv = await this.findValid(token);
    const problems = passwordProblems(input.password, { email: inv.email, displayName: input.displayName });
    if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', problems.join(' '), { problems });
    const passwordHash = await this.hasher.hash(input.password);
    return withSystem(this.db, async (tx) => {
      if (await tx.user.findUnique({ where: { email: inv.email }, select: { id: true } })) {
        throw new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists. Sign in to accept the invitation.');
      }
      const consumed = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (consumed.count !== 1) throw invalidInvite();
      const user = await tx.user.create({ data: { email: inv.email, displayName: input.displayName.trim(), passwordHash, emailVerifiedAt: new Date() } });
      await tx.organizationMembership.create({ data: { organizationId: inv.organizationId, userId: user.id, role: inv.role } });
      await this.audit.record(
        { action: 'org.invitation.accepted', organizationId: inv.organizationId, actorUserId: user.id, entityType: 'invitation', entityId: inv.id, metadata: { role: inv.role, newAccount: true }, ...meta },
        tx,
      );
      // 2FA may be required by the organization; the session state reflects that on the next request.
      return this.sessions.create({ userId: user.id, mfaVerified: true, ipAddress: meta.ipAddress, userAgent: meta.userAgent }, tx);
    });
  }

  private async findValid(token: string) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw invalidInvite();
    const inv = await withSystem(this.db, (tx) =>
      tx.invitation.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { organization: { select: { name: true, status: true } } } }),
    );
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now() || inv.organization.status !== 'ACTIVE') throw invalidInvite();
    return inv;
  }

  private async sendInvite(to: string, orgName: string, inviter: string, role: OrganizationRole, token: string): Promise<void> {
    try {
      await this.mailer.send({
        to,
        subject: `${inviter} invited you to ${orgName} on ${this.config.appName}`,
        text: `Hi,\n\n${inviter} invited you to join ${orgName} on ${this.config.appName} as ${ROLE_LABELS[role]}.\n\nAccept the invitation:\n${this.config.appBaseUrl}/invite#token=${token}\n\nThe link expires in 7 days and works once.\n\n-- \n${this.config.appName}\nIf you did not expect this, you can ignore this email.`,
      });
    } catch {
      // Delivery failures must not break the API response; the owner can resend.
    }
  }
}
