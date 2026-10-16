import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import { computeAuthState, hasRecentAuth, type AuthState } from '../modules/auth/auth-state.js';
import { cookieNames, type AuthUser, type SessionRecord, type SessionService } from '../modules/auth/session.service.js';
import { platformRoleHas, type PlatformPermission } from '../modules/rbac/permissions.js';
import { safeEqualHex, sha256Hex } from '../shared/crypto.js';
import { AppError } from '../shared/errors.js';

export interface AuthContext {
  session: SessionRecord;
  user: AuthUser;
  state: AuthState;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Resolves the session cookie (if any) into req.auth. Never rejects by itself. */
export function loadSession(sessions: SessionService, config: AppConfig): RequestHandler {
  const name = cookieNames(config.auth.cookieSecure).session;
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[name];
    const resolved = await sessions.resolve(token);
    if (resolved) req.auth = { ...resolved, state: computeAuthState(resolved.user, resolved.session, config) };
    next();
  };
}

/**
 * CSRF protection for cookie-authenticated, state-changing requests: the X-CSRF-Token header
 * must match the token bound to the session (synchronizer token, compared in constant time).
 * Anonymous endpoints (login, register, reset) are protected by the Origin allowlist and by
 * requiring a JSON body, which cross-site forms cannot send.
 */
export function csrfProtection(): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !UNSAFE.has(req.method)) return next();
    const header = req.get('x-csrf-token');
    if (!header || !safeEqualHex(sha256Hex(header), req.auth.session.csrfTokenHash)) {
      return next(new AppError(403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token. Reload the page and try again.'));
    }
    next();
  };
}

/** Requires a session in one of the allowed states (default: fully authenticated). */
export function requireAuth(allowed: AuthState[] = ['authenticated']): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    if (!allowed.includes(req.auth.state)) {
      const code = req.auth.state === 'mfa_pending' ? 'MFA_REQUIRED' : 'MFA_ENROLLMENT_REQUIRED';
      const message =
        req.auth.state === 'mfa_pending' ? 'Enter your two-factor authentication code.' : 'Set up two-factor authentication to continue.';
      return next(new AppError(403, code, message));
    }
    next();
  };
}

/** Sensitive operations need a recent password (and 2FA) confirmation. */
export function requireRecentAuth(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    if (!hasRecentAuth(req.auth.session, config)) {
      return next(new AppError(403, 'STEP_UP_REQUIRED', 'Confirm your password to continue.'));
    }
    next();
  };
}

export function requirePlatformPermission(permission: PlatformPermission): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user;
    if (!user) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    // Defense in depth: admin access additionally requires an enrolled and verified second factor.
    if (!platformRoleHas(user.platformRole, permission) || !user.totpEnabledAt || !req.auth?.session.mfaVerifiedAt) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'));
    }
    next();
  };
}
