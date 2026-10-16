import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env.js';
import { requireAuth, requireRecentAuth } from '../../middleware/auth.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody } from '../../shared/validate.js';
import { ORG_ROLE_PERMISSIONS, PLATFORM_ROLE_PERMISSIONS } from '../rbac/permissions.js';
import { hasRecentAuth, twoFactorRequired } from './auth-state.js';
import {
  ChangePasswordBody,
  EmailBody,
  EnableTotpBody,
  LoginBody,
  RegisterBody,
  ResetPasswordBody,
  SecondFactorBody,
  StepUpBody,
  TokenBody,
} from './auth.schemas.js';
import type { AuthService, RequestMeta } from './auth.service.js';
import type { AuthRateLimits } from './rate-limits.js';
import { clearSessionCookies, setSessionCookies, type AuthUser, type SessionRecord, type SessionService } from './session.service.js';

export function requestMeta(req: Request): RequestMeta {
  return { requestId: req.requestId, ipAddress: req.ip, userAgent: req.get('user-agent') };
}

const ACCEPTED = { status: 'accepted' as const };

export function authRouter(deps: { config: AppConfig; auth: AuthService; sessions: SessionService; limits: AuthRateLimits }): Router {
  const { config, auth, sessions, limits } = deps;
  const r = Router();
  const recent = requireRecentAuth(config);
  const fullOrEnrolling = requireAuth(['authenticated', 'mfa_enrollment_required']);

  function describe(user: AuthUser, session: SessionRecord, state: string) {
    return {
      state,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        platformRole: user.platformRole,
        twoFactorEnabled: !!user.totpEnabledAt,
        twoFactorRequired: twoFactorRequired(user, config),
      },
      // While a second factor is pending, expose nothing about the user's organizations.
      memberships:
        state === 'mfa_pending'
          ? []
          : user.memberships.map((m) => ({
              organizationId: m.organizationId,
              organizationName: m.organizationName,
              role: m.role,
              organizationStatus: m.organizationStatus,
              permissions: ORG_ROLE_PERMISSIONS[m.role],
            })),
      platformPermissions: state === 'authenticated' && user.platformRole && user.totpEnabledAt ? PLATFORM_ROLE_PERMISSIONS[user.platformRole] : [],
      session: { id: session.id, expiresAt: session.expiresAt.toISOString(), recentAuth: hasRecentAuth(session, config) },
    };
  }

  r.get('/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.auth) return sendData(res, { state: 'anonymous' });
    sendData(res, describe(req.auth.user, req.auth.session, req.auth.state));
  });

  r.post('/register', limits.register, async (req, res) => {
    const body = parseBody(RegisterBody, req);
    await auth.register(body, requestMeta(req));
    sendData(res, { ...ACCEPTED, message: 'Check your email to verify your address and finish signing up.' }, 202);
  });

  r.post('/verify-email', limits.tokenSubmit, async (req, res) => {
    const { token } = parseBody(TokenBody, req);
    await auth.verifyEmail(token, requestMeta(req));
    sendData(res, { status: 'verified' });
  });

  r.post('/verify-email/resend', limits.forgotIp, limits.resendAccount, async (req, res) => {
    const { email } = parseBody(EmailBody, req);
    await auth.resendVerification(email, requestMeta(req));
    sendData(res, { ...ACCEPTED, message: 'If that address needs verification, we sent a new link.' }, 202);
  });

  r.post('/login', limits.loginIp, limits.loginAccount, async (req, res) => {
    if (req.auth) await sessions.revoke(req.auth.session.id, 'replaced_by_login');
    const body = parseBody(LoginBody, req);
    const { issued, user } = await auth.login(body, requestMeta(req));
    setSessionCookies(res, config, issued);
    const state = user.totpEnabledAt ? 'mfa_pending' : twoFactorRequired(user, config) ? 'mfa_enrollment_required' : 'authenticated';
    sendData(res, describe(user, issued.session, state));
  });

  r.post('/2fa/verify', limits.secondFactor, requireAuth(['mfa_pending']), async (req, res) => {
    const body = parseBody(SecondFactorBody, req);
    try {
      const { issued, user } = await auth.verifySecondFactor(req.auth!.session, body, requestMeta(req));
      setSessionCookies(res, config, issued);
      sendData(res, describe(user, issued.session, 'authenticated'));
    } catch (err) {
      if (err instanceof AppError && err.code === 'MFA_SESSION_REVOKED') clearSessionCookies(res, config);
      throw err;
    }
  });

  r.post('/logout', requireAuth(['authenticated', 'mfa_pending', 'mfa_enrollment_required']), async (req, res) => {
    await auth.logout(req.auth!.session, requestMeta(req));
    clearSessionCookies(res, config);
    sendData(res, { status: 'signed_out' });
  });

  r.post('/password/forgot', limits.forgotIp, limits.forgotAccount, async (req, res) => {
    const { email } = parseBody(EmailBody, req);
    await auth.forgotPassword(email, requestMeta(req));
    sendData(res, { ...ACCEPTED, message: 'If an account exists for that address, we sent a reset link.' }, 202);
  });

  r.post('/password/reset', limits.tokenSubmit, async (req, res) => {
    const body = parseBody(ResetPasswordBody, req);
    await auth.resetPassword(body, requestMeta(req));
    if (req.auth) clearSessionCookies(res, config);
    sendData(res, { status: 'password_reset' });
  });

  r.post('/password/change', requireAuth(), recent, async (req, res) => {
    const { newPassword } = parseBody(ChangePasswordBody, req);
    await auth.changePassword(req.auth!.session, newPassword, requestMeta(req));
    sendData(res, { status: 'password_changed' });
  });

  r.post('/step-up', limits.stepUp, fullOrEnrolling, async (req, res) => {
    const body = parseBody(StepUpBody, req);
    await auth.stepUp(req.auth!.session, body, requestMeta(req));
    sendData(res, { status: 'confirmed', validForMinutes: Math.round(config.auth.stepUpWindowMs / 60_000) });
  });

  r.post('/2fa/setup', fullOrEnrolling, recent, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, await auth.setupTotp(req.auth!.session));
  });

  r.post('/2fa/enable', limits.secondFactor, fullOrEnrolling, recent, async (req, res) => {
    const { code } = parseBody(EnableTotpBody, req);
    const { recoveryCodes, issued } = await auth.enableTotp(req.auth!.session, code, requestMeta(req));
    setSessionCookies(res, config, issued);
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, { status: 'enabled', recoveryCodes });
  });

  r.post('/2fa/disable', requireAuth(), recent, async (req, res) => {
    await auth.disableTotp(req.auth!.session, requestMeta(req));
    sendData(res, { status: 'disabled' });
  });

  r.post('/2fa/recovery-codes', requireAuth(), recent, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, { recoveryCodes: await auth.regenerateRecoveryCodes(req.auth!.session, requestMeta(req)) });
  });

  r.get('/2fa/status', requireAuth(), async (req, res) => {
    sendData(res, {
      enabled: !!req.auth!.user.totpEnabledAt,
      required: twoFactorRequired(req.auth!.user, config),
      recoveryCodesRemaining: req.auth!.user.totpEnabledAt ? await auth.recoveryCodesRemaining(req.auth!.user.id) : 0,
    });
  });

  r.post('/email/change', requireAuth(), recent, async (req, res) => {
    const { email } = parseBody(EmailBody, req);
    await auth.requestEmailChange(req.auth!.session, email, requestMeta(req));
    sendData(res, { ...ACCEPTED, message: 'Check the new address for a confirmation link.' }, 202);
  });

  r.post('/email/confirm', limits.tokenSubmit, async (req, res) => {
    const { token } = parseBody(TokenBody, req);
    await auth.confirmEmailChange(token, requestMeta(req));
    if (req.auth) clearSessionCookies(res, config);
    sendData(res, { status: 'email_changed' });
  });

  r.get('/sessions', requireAuth(), async (req, res) => {
    const list = await sessions.list(req.auth!.user.id);
    sendData(
      res,
      list.map((s) => ({ ...s, current: s.id === req.auth!.session.id })),
    );
  });

  r.delete('/sessions/:sessionId', requireAuth(), async (req, res) => {
    const id = req.params['sessionId'];
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'NOT_FOUND', 'Session not found');
    await auth.revokeSession(req.auth!.session, id, requestMeta(req));
    if (id === req.auth!.session.id) clearSessionCookies(res, config);
    sendData(res, { status: 'revoked' });
  });

  r.post('/sessions/revoke-others', requireAuth(), async (req, res) => {
    sendData(res, { status: 'revoked', count: await auth.revokeOtherSessions(req.auth!.session, requestMeta(req)) });
  });

  return r;
}
