import type { AppConfig } from '../../config/env.js';
import type { AuthUser, SessionRecord } from './session.service.js';

/**
 * authenticated            - full access according to role
 * mfa_pending              - password accepted, second factor not yet verified
 * mfa_enrollment_required  - 2FA is mandatory for this user but not set up yet
 */
export type AuthState = 'authenticated' | 'mfa_pending' | 'mfa_enrollment_required';

export function twoFactorRequired(user: AuthUser, config: AppConfig): boolean {
  if (user.platformRole !== null) return true; // mandatory for platform administrators
  if (user.memberships.some((m) => m.twoFactorRequired)) return true; // organization policy
  return config.auth.owner2faPolicy === 'required' && user.memberships.some((m) => m.role === 'ORG_OWNER');
}

export function computeAuthState(user: AuthUser, session: SessionRecord, config: AppConfig): AuthState {
  if (user.totpEnabledAt && !session.mfaVerifiedAt) return 'mfa_pending';
  if (!user.totpEnabledAt && twoFactorRequired(user, config)) return 'mfa_enrollment_required';
  return 'authenticated';
}

/** Recent authentication: an explicit step-up, or a fresh login, within the configured window. */
export function hasRecentAuth(session: SessionRecord, config: AppConfig, now = Date.now()): boolean {
  const window = config.auth.stepUpWindowMs;
  const stepUp = session.stepUpAt?.getTime() ?? 0;
  return now - stepUp < window || now - session.createdAt.getTime() < window;
}
