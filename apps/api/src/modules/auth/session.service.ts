import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, type Tx } from '../../infrastructure/db/tenant.js';
import { randomToken, sha256Hex } from '../../shared/crypto.js';
import type { OrganizationRole, OrganizationStatus, PlatformRole, UserStatus } from '../../generated/prisma/enums.js';

export interface SessionRecord {
  id: string;
  userId: string;
  csrfTokenHash: string;
  mfaVerifiedAt: Date | null;
  mfaFailedAttempts: number;
  stepUpAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  platformRole: PlatformRole | null;
  emailVerifiedAt: Date | null;
  totpEnabledAt: Date | null;
  memberships: { organizationId: string; role: OrganizationRole; organizationName: string; twoFactorRequired: boolean; organizationStatus: OrganizationStatus }[];
}

export interface IssuedSession {
  session: SessionRecord;
  token: string;
  csrfToken: string;
}

const TOUCH_INTERVAL_MS = 60_000;

const userSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  platformRole: true,
  emailVerifiedAt: true,
  totpEnabledAt: true,
  memberships: { select: { organizationId: true, role: true, organization: { select: { name: true, twoFactorRequired: true, status: true } } }, orderBy: { createdAt: 'asc' } },
} as const;

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  platformRole: PlatformRole | null;
  emailVerifiedAt: Date | null;
  totpEnabledAt: Date | null;
  memberships: { organizationId: string; role: OrganizationRole; organization: { name: string; twoFactorRequired: boolean; status: OrganizationStatus } }[];
};

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    platformRole: row.platformRole,
    emailVerifiedAt: row.emailVerifiedAt,
    totpEnabledAt: row.totpEnabledAt,
    memberships: row.memberships.map((m) => ({
      organizationId: m.organizationId,
      role: m.role,
      organizationName: m.organization.name,
      twoFactorRequired: m.organization.twoFactorRequired,
      organizationStatus: m.organization.status,
    })),
  };
}

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** Creates a new session with fresh random session and CSRF tokens. Only hashes are stored. */
  async create(
    input: { userId: string; mfaVerified: boolean; ipAddress?: string; userAgent?: string },
    tx?: Tx,
  ): Promise<IssuedSession> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const now = new Date();
    const data = {
      userId: input.userId,
      tokenHash: sha256Hex(token),
      csrfTokenHash: sha256Hex(csrfToken),
      mfaVerifiedAt: input.mfaVerified ? now : null,
      ipAddress: input.ipAddress?.replace(/^::ffff:/, '') ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.config.auth.sessionTtlMs),
    };
    const session = tx ? await tx.session.create({ data }) : await withSystem(this.db, (t) => t.session.create({ data }));
    return { session, token, csrfToken };
  }

  /** Returns the session and user for a cookie token, or null if invalid, expired, idle, revoked or the user is disabled. */
  async resolve(token: string | undefined): Promise<{ session: SessionRecord; user: AuthUser } | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    const now = Date.now();
    const row = await withSystem(this.db, (tx) =>
      tx.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: { select: userSelect } } }),
    );
    if (!row || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= now) return null;
    if (row.lastSeenAt.getTime() + this.config.auth.sessionIdleMs <= now) {
      await this.revoke(row.id, 'idle_timeout');
      return null;
    }
    if (row.user.status !== 'ACTIVE') return null;
    if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await withSystem(this.db, (tx) => tx.session.update({ where: { id: row.id }, data: { lastSeenAt: new Date(now) } }));
    }
    const { user, ...session } = row;
    return { session, user: toAuthUser(user) };
  }

  async loadUser(userId: string): Promise<AuthUser | null> {
    const row = await withSystem(this.db, (tx) => tx.user.findUnique({ where: { id: userId }, select: userSelect }));
    return row ? toAuthUser(row) : null;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await withSystem(this.db, (tx) =>
      tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } }),
    );
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string, tx?: Tx): Promise<number> {
    const run = (t: Tx) =>
      t.session.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    const result = tx ? await run(tx) : await withSystem(this.db, run);
    return result.count;
  }

  /** Replaces a session with a new one (new tokens) to prevent session fixation after a privilege change. */
  async rotate(old: SessionRecord, input: { mfaVerified: boolean; ipAddress?: string; userAgent?: string }): Promise<IssuedSession> {
    return withSystem(this.db, async (tx) => {
      await tx.session.update({ where: { id: old.id }, data: { revokedAt: new Date(), revokedReason: 'rotated' } });
      return this.create({ userId: old.userId, ...input }, tx);
    });
  }

  list(userId: string) {
    return withSystem(this.db, (tx) =>
      tx.session.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ipAddress: true, userAgent: true, mfaVerifiedAt: true },
      }),
    );
  }
}

// --- cookies -----------------------------------------------------------------

export function cookieNames(secure: boolean) {
  // The __Host- prefix requires Secure, Path=/ and no Domain: the browser then refuses
  // cookies set by subdomains or over plain HTTP.
  return { session: secure ? '__Host-ss_session' : 'ss_session', csrf: 'ss_csrf' } as const;
}

export function setSessionCookies(res: Response, config: AppConfig, issued: IssuedSession): void {
  const secure = config.auth.cookieSecure;
  const names = cookieNames(secure);
  const maxAge = issued.session.expiresAt.getTime() - Date.now();
  const base: CookieOptions = { secure, path: '/', maxAge };
  res.cookie(names.session, issued.token, { ...base, httpOnly: true, sameSite: 'lax' });
  // Readable by the SPA so it can echo the value in the X-CSRF-Token header.
  res.cookie(names.csrf, issued.csrfToken, { ...base, httpOnly: false, sameSite: 'strict' });
}

export function clearSessionCookies(res: Response, config: AppConfig): void {
  const secure = config.auth.cookieSecure;
  const names = cookieNames(secure);
  res.clearCookie(names.session, { secure, path: '/', httpOnly: true, sameSite: 'lax' });
  res.clearCookie(names.csrf, { secure, path: '/', sameSite: 'strict' });
}
