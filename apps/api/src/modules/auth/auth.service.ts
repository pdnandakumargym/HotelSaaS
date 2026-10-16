import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Mailer } from '../../infrastructure/mail/mailer.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, type Tx } from '../../infrastructure/db/tenant.js';
import { decryptString, deriveKey, encryptString, hmacHex, randomToken, sha256Hex } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { createDefaultSubscription } from '../subscriptions/plan-limits.js';
import { twoFactorRequired } from './auth-state.js';
import * as emails from './emails.js';
import { passwordProblems, type PasswordHasher } from './password.js';
import type { AuthUser, IssuedSession, SessionRecord, SessionService } from './session.service.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export interface RequestMeta extends AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

const VERIFY_EMAIL_TTL_MS = 24 * 3_600_000;
const PASSWORD_RESET_TTL_MS = 30 * 60_000;
const MAX_MFA_ATTEMPTS_PER_SESSION = 5;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U

export const INVALID_CREDENTIALS_MESSAGE =
  'Invalid email or password. After repeated failed attempts, sign-in is paused for a few minutes.';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invalidCredentials(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'org';
}

export function formatRecoveryCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export type LoginResult = { issued: IssuedSession; user: AuthUser };

/**
 * Authentication use cases. HTTP-agnostic: routes translate requests into these calls.
 * All lookups that are not tenant-scoped run in a system (RLS-bypass) transaction.
 */
export class AuthService {
  private readonly totpKey: Buffer;
  private readonly recoveryKey: Buffer;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.totpKey = deriveKey(config.auth.dataEncryptionKey, 'totp-secret-encryption');
    this.recoveryKey = deriveKey(config.auth.dataEncryptionKey, 'recovery-code-hmac');
  }

  // --- registration & email verification ------------------------------------

  /**
   * Creates a user, their organization and an owner membership. The response is the same
   * whether or not the email is already registered (prevents account enumeration); an
   * existing account owner gets a notification email instead.
   */
  async register(
    input: { email: string; password: string; displayName: string; organizationName: string },
    meta: RequestMeta,
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    const problems = passwordProblems(input.password, { email, displayName: input.displayName });
    if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', problems.join(' '), { problems });

    const existing = await withSystem(this.db, (tx) => tx.user.findUnique({ where: { email }, select: { id: true } }));
    if (existing) {
      await this.hasher.burn(input.password);
      await this.safeSend(emails.alreadyRegistered(email, this.config));
      await this.audit.record({ action: 'auth.register.duplicate', actorType: 'anonymous', entityType: 'user', entityId: existing.id, ...meta });
      return;
    }

    const passwordHash = await this.hasher.hash(input.password);
    const token = randomToken(32);
    const user = await withSystem(this.db, async (tx) => {
      const created = await tx.user.create({ data: { email, displayName: input.displayName.trim(), passwordHash } });
      const org = await tx.organization.create({
        data: { name: input.organizationName.trim(), slug: await this.uniqueSlug(tx, input.organizationName) },
      });
      await tx.organizationMembership.create({ data: { organizationId: org.id, userId: created.id, role: 'ORG_OWNER' } });
      await createDefaultSubscription(tx, org.id, new Date(this.now()));
      await tx.oneTimeToken.create({
        data: { userId: created.id, purpose: 'VERIFY_EMAIL', tokenHash: sha256Hex(token), expiresAt: new Date(this.now() + VERIFY_EMAIL_TTL_MS) },
      });
      await this.audit.record(
        { action: 'auth.register', organizationId: org.id, actorUserId: created.id, entityType: 'user', entityId: created.id, ...meta },
        tx,
      );
      return created;
    });
    await this.safeSend(emails.verifyEmail(user.email, user.displayName, token, this.config));
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const record = await this.consumeToken(token, 'VERIFY_EMAIL');
    await withSystem(this.db, async (tx) => {
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date(this.now()) } });
      await this.audit.record({ action: 'auth.email.verified', actorUserId: record.userId, entityType: 'user', entityId: record.userId, ...meta }, tx);
    });
  }

  /** Always succeeds from the caller's point of view. */
  async resendVerification(emailInput: string, meta: RequestMeta): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await withSystem(this.db, (tx) => tx.user.findUnique({ where: { email } }));
    if (!user || user.emailVerifiedAt || user.status !== 'ACTIVE') return;
    const token = randomToken(32);
    await withSystem(this.db, async (tx) => {
      await tx.oneTimeToken.updateMany({ where: { userId: user.id, purpose: 'VERIFY_EMAIL', usedAt: null }, data: { usedAt: new Date(this.now()) } });
      await tx.oneTimeToken.create({
        data: { userId: user.id, purpose: 'VERIFY_EMAIL', tokenHash: sha256Hex(token), expiresAt: new Date(this.now() + VERIFY_EMAIL_TTL_MS) },
      });
    });
    await this.audit.record({ action: 'auth.email.verification_resent', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta });
    await this.safeSend(emails.verifyEmail(user.email, user.displayName, token, this.config));
  }

  // --- login -------------------------------------------------------------------

  async login(input: { email: string; password: string }, meta: RequestMeta): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const user = await withSystem(this.db, (tx) => tx.user.findUnique({ where: { email } }));

    if (!user) {
      await this.hasher.burn(input.password);
      await this.audit.record({
        action: 'auth.login.failed',
        actorType: 'anonymous',
        metadata: { reason: 'unknown_account', emailHash: sha256Hex(email).slice(0, 16) },
        ...meta,
      });
      throw invalidCredentials();
    }

    const now = this.now();
    if (user.lockedUntil && user.lockedUntil.getTime() > now) {
      // Do not evaluate the password while locked: no guesses are possible during a lockout.
      await this.audit.record({ action: 'auth.login.blocked_locked', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta });
      throw invalidCredentials();
    }

    if (!(await this.hasher.verify(user.passwordHash, input.password))) {
      await this.registerFailure(user.id, meta, 'password');
      throw invalidCredentials();
    }

    // Credentials are correct from here on, so account state may be revealed.
    if (user.status !== 'ACTIVE') {
      await this.audit.record({ action: 'auth.login.failed', actorUserId: user.id, metadata: { reason: 'disabled' }, ...meta });
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled. Contact support.');
    }
    if (!user.emailVerifiedAt) {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first. We can send you a new link.');
    }

    const mfaVerified = !user.totpEnabledAt;
    const issued = await withSystem(this.db, async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastFailedLoginAt: null,
          ...(mfaVerified ? { lastLoginAt: new Date(now) } : {}),
          ...(this.hasher.needsRehash(user.passwordHash) ? { passwordHash: await this.hasher.hash(input.password) } : {}),
        },
      });
      const created = await this.sessions.create({ userId: user.id, mfaVerified, ipAddress: meta.ipAddress, userAgent: meta.userAgent }, tx);
      await this.audit.record(
        {
          action: mfaVerified ? 'auth.login.succeeded' : 'auth.login.password_accepted_mfa_pending',
          actorUserId: user.id,
          entityType: 'session',
          entityId: created.session.id,
          ...meta,
        },
        tx,
      );
      return created;
    });
    const authUser = await this.requireUser(user.id);
    return { issued, user: authUser };
  }

  /** Verifies a TOTP code or a recovery code for a session that is waiting for its second factor. */
  async verifySecondFactor(
    session: SessionRecord,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    if (!user.totpSecretEnc) throw new AppError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
    if (user.lockedUntil && user.lockedUntil.getTime() > this.now()) throw invalidCredentials();

    const ok = await this.checkSecondFactor(user.id, user.totpSecretEnc, user.totpLastUsedStep, input, meta);
    if (!ok) {
      const attempts = session.mfaFailedAttempts + 1;
      await withSystem(this.db, (tx) => tx.session.update({ where: { id: session.id }, data: { mfaFailedAttempts: attempts } }));
      await this.registerFailure(user.id, meta, 'second_factor');
      if (attempts >= MAX_MFA_ATTEMPTS_PER_SESSION) {
        await this.sessions.revoke(session.id, 'mfa_attempts_exceeded');
        throw new AppError(401, 'MFA_SESSION_REVOKED', 'Too many incorrect codes. Sign in again.');
      }
      throw new AppError(401, 'INVALID_MFA_CODE', 'That code is not valid. Try again.');
    }

    await withSystem(this.db, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(this.now()) } }),
    );
    const issued = await this.sessions.rotate(session, { mfaVerified: true, ipAddress: meta.ipAddress, userAgent: meta.userAgent });
    await this.audit.record({ action: 'auth.login.succeeded', actorUserId: user.id, entityType: 'session', entityId: issued.session.id, metadata: { mfa: true }, ...meta });
    return { issued, user: await this.requireUser(user.id) };
  }

  async logout(session: SessionRecord, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(session.id, 'logout');
    await this.audit.record({ action: 'auth.logout', actorUserId: session.userId, entityType: 'session', entityId: session.id, ...meta });
  }

  /** Confirms the user's identity again before sensitive changes. */
  async stepUp(session: SessionRecord, input: { password: string; code?: string }, meta: RequestMeta): Promise<void> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    if (user.lockedUntil && user.lockedUntil.getTime() > this.now()) throw invalidCredentials();
    const passwordOk = await this.hasher.verify(user.passwordHash, input.password);
    let factorOk = true;
    if (passwordOk && user.totpSecretEnc) {
      factorOk = input.code ? await this.checkSecondFactor(user.id, user.totpSecretEnc, user.totpLastUsedStep, { code: input.code }, meta) : false;
      if (!input.code) throw new AppError(400, 'MFA_CODE_REQUIRED', 'Enter the code from your authenticator app.');
    }
    if (!passwordOk || !factorOk) {
      await this.registerFailure(user.id, meta, 'step_up');
      throw new AppError(401, 'STEP_UP_FAILED', 'Password or code is incorrect.');
    }
    await withSystem(this.db, (tx) => tx.session.update({ where: { id: session.id }, data: { stepUpAt: new Date(this.now()) } }));
    await this.audit.record({ action: 'auth.step_up', actorUserId: user.id, entityType: 'session', entityId: session.id, ...meta });
  }

  // --- password reset & change ---------------------------------------------------

  async forgotPassword(emailInput: string, meta: RequestMeta): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await withSystem(this.db, (tx) => tx.user.findUnique({ where: { email } }));
    if (!user || user.status !== 'ACTIVE') {
      await this.audit.record({ action: 'auth.password.reset_requested_unknown', actorType: 'anonymous', metadata: { emailHash: sha256Hex(email).slice(0, 16) }, ...meta });
      return;
    }
    const token = randomToken(32);
    await withSystem(this.db, async (tx) => {
      // Only the newest reset link works.
      await tx.oneTimeToken.updateMany({ where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date(this.now()) } });
      await tx.oneTimeToken.create({
        data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(this.now() + PASSWORD_RESET_TTL_MS) },
      });
      await this.audit.record({ action: 'auth.password.reset_requested', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
    });
    await this.safeSend(emails.passwordReset(user.email, user.displayName, token, this.config));
  }

  /**
   * Sets a new password from a reset link. If 2FA is enabled, a TOTP or recovery code is
   * required too, so a compromised mailbox alone cannot take over the account.
   * All sessions are revoked and the lockout is cleared.
   */
  async resetPassword(
    input: { token: string; password: string; code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<void> {
    const tokenHash = sha256Hex(input.token);
    const record = await withSystem(this.db, (tx) => tx.oneTimeToken.findUnique({ where: { tokenHash }, include: { user: true } }));
    if (!record || record.purpose !== 'PASSWORD_RESET' || record.usedAt || record.expiresAt.getTime() <= this.now()) {
      throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired. Request a new one.');
    }
    const user = record.user;
    const problems = passwordProblems(input.password, { email: user.email, displayName: user.displayName });
    if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', problems.join(' '), { problems });

    if (user.totpSecretEnc) {
      if (!input.code && !input.recoveryCode) {
        throw new AppError(400, 'MFA_CODE_REQUIRED', 'Enter a code from your authenticator app or a recovery code.');
      }
      const ok = await this.checkSecondFactor(user.id, user.totpSecretEnc, user.totpLastUsedStep, input, meta);
      if (!ok) {
        await this.registerFailure(user.id, meta, 'reset_second_factor');
        throw new AppError(401, 'INVALID_MFA_CODE', 'That code is not valid.');
      }
    }

    const passwordHash = await this.hasher.hash(input.password);
    await withSystem(this.db, async (tx) => {
      const consumed = await tx.oneTimeToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date(this.now()) } });
      if (consumed.count !== 1) throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired. Request a new one.');
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(this.now()),
          failedLoginCount: 0,
          lockedUntil: null,
          // Completing a reset proves control of the mailbox.
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(this.now()),
        },
      });
      await this.sessions.revokeAllForUser(user.id, 'password_reset', undefined, tx);
      await this.audit.record({ action: 'auth.password.reset_completed', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
    });
    await this.safeSend(emails.passwordChanged(user.email, user.displayName, this.config));
  }

  /** Requires recent authentication (enforced by the route). Other sessions are signed out. */
  async changePassword(session: SessionRecord, newPassword: string, meta: RequestMeta): Promise<void> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    const problems = passwordProblems(newPassword, { email: user.email, displayName: user.displayName });
    if (problems.length) throw new AppError(400, 'WEAK_PASSWORD', problems.join(' '), { problems });
    if (await this.hasher.verify(user.passwordHash, newPassword)) {
      throw new AppError(400, 'PASSWORD_UNCHANGED', 'Choose a password you have not used for this account.');
    }
    const passwordHash = await this.hasher.hash(newPassword);
    await withSystem(this.db, async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date(this.now()) } });
      await this.sessions.revokeAllForUser(user.id, 'password_changed', session.id, tx);
      await this.audit.record({ action: 'auth.password.changed', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
    });
    await this.safeSend(emails.passwordChanged(user.email, user.displayName, this.config));
  }

  // --- two-factor authentication -----------------------------------------------

  /** Starts (or restarts) enrollment. The secret is stored encrypted as "pending" until confirmed. */
  async setupTotp(session: SessionRecord): Promise<{ secret: string; otpauthUri: string; qrDataUrl: string }> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    const secret = generateTotpSecret();
    await withSystem(this.db, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { totpPendingSecretEnc: this.encryptTotp(user.id, secret) } }),
    );
    const uri = otpauthUri(this.config.appName, user.email, secret);
    const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
    return { secret, otpauthUri: uri, qrDataUrl };
  }

  /** Confirms enrollment with a valid code. Returns recovery codes, shown to the user exactly once. */
  async enableTotp(session: SessionRecord, code: string, meta: RequestMeta): Promise<{ recoveryCodes: string[]; issued: IssuedSession }> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    if (!user.totpPendingSecretEnc) throw new AppError(400, 'MFA_SETUP_NOT_STARTED', 'Start two-factor setup first.');
    const secret = this.decryptTotp(user.id, user.totpPendingSecretEnc);
    const step = verifyTotp(secret, code, { nowMs: this.now() });
    if (step === null) throw new AppError(400, 'INVALID_MFA_CODE', 'That code is not valid. Check the time on your phone and try again.');

    const codes = this.generateRecoveryCodes();
    await withSystem(this.db, async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          totpSecretEnc: this.encryptTotp(user.id, secret),
          totpPendingSecretEnc: null,
          totpEnabledAt: new Date(this.now()),
          totpLastUsedStep: BigInt(step),
        },
      });
      await this.replaceRecoveryCodes(tx, user.id, codes);
      await this.audit.record({ action: 'auth.2fa.enabled', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
    });
    // New privileges (verified second factor) -> new session tokens.
    const issued = await this.sessions.rotate(session, { mfaVerified: true, ipAddress: meta.ipAddress, userAgent: meta.userAgent });
    return { recoveryCodes: codes.map(formatRecoveryCode), issued };
  }

  async disableTotp(session: SessionRecord, meta: RequestMeta): Promise<void> {
    const authUser = await this.requireUser(session.userId);
    if (!authUser.totpEnabledAt) throw new AppError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
    if (twoFactorRequired(authUser, this.config)) {
      throw new AppError(403, 'MFA_MANDATORY', 'Two-factor authentication is required for your account and cannot be turned off.');
    }
    await withSystem(this.db, async (tx) => {
      await tx.user.update({
        where: { id: authUser.id },
        data: { totpSecretEnc: null, totpPendingSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null },
      });
      await tx.recoveryCode.deleteMany({ where: { userId: authUser.id } });
      await this.audit.record({ action: 'auth.2fa.disabled', actorUserId: authUser.id, entityType: 'user', entityId: authUser.id, ...meta }, tx);
    });
    await this.safeSend(emails.twoFactorDisabled(authUser.email, authUser.displayName, this.config));
  }

  async regenerateRecoveryCodes(session: SessionRecord, meta: RequestMeta): Promise<string[]> {
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    if (!user.totpEnabledAt) throw new AppError(400, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
    const codes = this.generateRecoveryCodes();
    await withSystem(this.db, async (tx) => {
      await this.replaceRecoveryCodes(tx, user.id, codes);
      await this.audit.record({ action: 'auth.2fa.recovery_codes_regenerated', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
    });
    return codes.map(formatRecoveryCode);
  }

  async recoveryCodesRemaining(userId: string): Promise<number> {
    return withSystem(this.db, (tx) => tx.recoveryCode.count({ where: { userId, usedAt: null } }));
  }

  // --- sessions ------------------------------------------------------------------

  async revokeSession(session: SessionRecord, targetId: string, meta: RequestMeta): Promise<void> {
    const target = await withSystem(this.db, (tx) => tx.session.findUnique({ where: { id: targetId } }));
    // Same 404 for "not yours" and "does not exist".
    if (!target || target.userId !== session.userId || target.revokedAt) throw new AppError(404, 'NOT_FOUND', 'Session not found');
    await this.sessions.revoke(target.id, target.id === session.id ? 'logout' : 'revoked_by_user');
    await this.audit.record({ action: 'auth.session.revoked', actorUserId: session.userId, entityType: 'session', entityId: target.id, ...meta });
  }

  async revokeOtherSessions(session: SessionRecord, meta: RequestMeta): Promise<number> {
    const count = await this.sessions.revokeAllForUser(session.userId, 'revoked_by_user', session.id);
    await this.audit.record({ action: 'auth.session.revoked_others', actorUserId: session.userId, metadata: { count }, ...meta });
    return count;
  }

  // --- email change -----------------------------------------------------------------

  /**
   * Starts an email change (recent authentication required by the route). A confirmation link
   * goes to the NEW address; the old address is told about the request. If the new address
   * already belongs to an account, the response is the same (no enumeration) and that
   * address is told instead.
   */
  async requestEmailChange(session: SessionRecord, newEmailInput: string, meta: RequestMeta): Promise<void> {
    const newEmail = normalizeEmail(newEmailInput);
    const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: session.userId } }));
    if (newEmail === user.email) throw new AppError(400, 'EMAIL_UNCHANGED', 'That is already your email address.');
    const taken = await withSystem(this.db, (tx) => tx.user.count({ where: { email: newEmail } }));
    await this.audit.record({ action: 'auth.email_change.requested', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta });
    if (taken > 0) {
      await this.safeSend(emails.emailInUse(newEmail, this.config));
      return;
    }
    const token = randomToken(32);
    await withSystem(this.db, async (tx) => {
      await tx.oneTimeToken.updateMany({ where: { userId: user.id, purpose: 'EMAIL_CHANGE', usedAt: null }, data: { usedAt: new Date(this.now()) } });
      await tx.user.update({ where: { id: user.id }, data: { pendingEmail: newEmail } });
      await tx.oneTimeToken.create({
        data: { userId: user.id, purpose: 'EMAIL_CHANGE', tokenHash: sha256Hex(token), expiresAt: new Date(this.now() + 60 * 60_000) },
      });
    });
    await this.safeSend(emails.confirmEmailChange(newEmail, user.displayName, token, this.config));
    await this.safeSend(emails.emailChangeRequested(user.email, user.displayName, newEmail, this.config));
  }

  async confirmEmailChange(token: string, meta: RequestMeta): Promise<void> {
    const record = await this.consumeToken(token, 'EMAIL_CHANGE');
    const { oldEmail, newEmail, name } = await withSystem(this.db, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
      if (!user.pendingEmail) throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired. Request a new one.');
      if (await tx.user.count({ where: { email: user.pendingEmail } })) {
        throw new AppError(409, 'EMAIL_TAKEN', 'That address is now used by another account.');
      }
      await tx.user.update({ where: { id: user.id }, data: { email: user.pendingEmail, pendingEmail: null, emailVerifiedAt: new Date(this.now()) } });
      // Sign out everywhere: the account's identity changed.
      await this.sessions.revokeAllForUser(user.id, 'email_changed', undefined, tx);
      await this.audit.record({ action: 'auth.email_change.completed', actorUserId: user.id, entityType: 'user', entityId: user.id, ...meta }, tx);
      return { oldEmail: user.email, newEmail: user.pendingEmail, name: user.displayName };
    });
    await this.safeSend(emails.emailChanged(oldEmail, name, newEmail, this.config));
  }

  // --- internals -------------------------------------------------------------------

  private async requireUser(id: string): Promise<AuthUser> {
    const user = await this.sessions.loadUser(id);
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    return user;
  }

  /**
   * Counts a failed attempt. Failures older than the window are forgotten. Reaching the
   * threshold locks the account temporarily with exponential backoff, capped so attackers
   * cannot lock a user out permanently.
   */
  private async registerFailure(userId: string, meta: RequestMeta, kind: string): Promise<void> {
    const { auth } = this.config;
    const now = this.now();
    const result = await withSystem(this.db, async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      const stale = !u.lastFailedLoginAt || now - u.lastFailedLoginAt.getTime() > auth.failureWindowMs;
      const count = (stale ? 0 : u.failedLoginCount) + 1;
      let lockedUntil: Date | null = null;
      if (count >= auth.lockoutThreshold) {
        const exponent = Math.min(count - auth.lockoutThreshold, 20);
        lockedUntil = new Date(now + Math.min(auth.lockoutBaseMs * 2 ** exponent, auth.lockoutMaxMs));
      }
      await tx.user.update({ where: { id: userId }, data: { failedLoginCount: count, lastFailedLoginAt: new Date(now), lockedUntil } });
      return { count, lockedUntil, email: u.email, displayName: u.displayName, wasLocked: !!u.lockedUntil && u.lockedUntil.getTime() > now };
    });
    await this.audit.record({
      action: 'auth.login.failed',
      actorUserId: userId,
      entityType: 'user',
      entityId: userId,
      metadata: { reason: kind, consecutiveFailures: result.count },
      ...meta,
    });
    if (result.lockedUntil && !result.wasLocked) {
      await this.audit.record({
        action: 'auth.account.locked',
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        metadata: { until: result.lockedUntil.toISOString() },
        ...meta,
      });
      if (this.config.auth.notifySuspiciousActivity) {
        await this.safeSend(emails.accountLocked(result.email, result.displayName, result.lockedUntil, this.config));
      }
    }
  }

  private async checkSecondFactor(
    userId: string,
    secretEnc: string,
    lastUsedStep: bigint | null,
    input: { code?: string; recoveryCode?: string },
    meta: RequestMeta,
  ): Promise<boolean> {
    if (input.code) {
      const secret = this.decryptTotp(userId, secretEnc);
      const step = verifyTotp(secret, input.code, { nowMs: this.now(), lastUsedStep: lastUsedStep === null ? null : Number(lastUsedStep) });
      if (step === null) return false;
      // Conditional update: two concurrent requests cannot both use the same step.
      const updated = await withSystem(this.db, (tx) =>
        tx.user.updateMany({
          where: { id: userId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: BigInt(step) } }] },
          data: { totpLastUsedStep: BigInt(step) },
        }),
      );
      return updated.count === 1;
    }
    if (input.recoveryCode) {
      const codeHash = hmacHex(this.recoveryKey, normalizeRecoveryCode(input.recoveryCode));
      const used = await withSystem(this.db, (tx) =>
        tx.recoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: new Date(this.now()) } }),
      );
      if (used.count !== 1) return false;
      const remaining = await this.recoveryCodesRemaining(userId);
      await this.audit.record({ action: 'auth.2fa.recovery_code_used', actorUserId: userId, metadata: { remaining }, ...meta });
      const user = await withSystem(this.db, (tx) => tx.user.findUniqueOrThrow({ where: { id: userId } }));
      await this.safeSend(emails.recoveryCodeUsed(user.email, user.displayName, remaining, this.config));
      return true;
    }
    return false;
  }

  private generateRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join(''),
    );
  }

  private async replaceRecoveryCodes(tx: Tx, userId: string, codes: string[]): Promise<void> {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hmacHex(this.recoveryKey, c) })) });
  }

  private encryptTotp(userId: string, secret: string): string {
    return encryptString(this.totpKey, secret, `totp:${userId}`);
  }

  private decryptTotp(userId: string, enc: string): string {
    return decryptString(this.totpKey, enc, `totp:${userId}`);
  }

  private async consumeToken(token: string, purpose: 'VERIFY_EMAIL' | 'PASSWORD_RESET' | 'EMAIL_CHANGE') {
    const tokenHash = sha256Hex(token);
    return withSystem(this.db, async (tx) => {
      const record = await tx.oneTimeToken.findUnique({ where: { tokenHash } });
      if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt.getTime() <= this.now()) {
        throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired. Request a new one.');
      }
      const consumed = await tx.oneTimeToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date(this.now()) } });
      if (consumed.count !== 1) throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired. Request a new one.');
      return record;
    });
  }

  private async uniqueSlug(tx: Tx, name: string): Promise<string> {
    const base = slugify(name);
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? base : `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      if (!(await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  /** Email delivery failures are logged but never change the API response (prevents enumeration and outages). */
  private async safeSend(message: { to: string; subject: string; text: string }): Promise<void> {
    try {
      await this.mailer.send(message);
    } catch (err) {
      this.logger.error({ err, subject: message.subject }, 'failed to send email');
    }
  }
}
