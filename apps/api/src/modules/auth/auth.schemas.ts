import { z } from 'zod';
import { registry } from '../../openapi/registry.js';
import { PASSWORD_MAX_LENGTH } from './password.js';

const email = z.string().trim().pipe(z.email().max(254));
// Length is checked by the password policy so the error message is helpful; cap size here.
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const token = z.string().min(20).max(200);
const totpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const recoveryCode = z.string().min(10).max(20);

export const RegisterBody = registry.register(
  'RegisterRequest',
  z.object({
    email,
    password,
    displayName: z.string().trim().min(1).max(120),
    organizationName: z.string().trim().min(2).max(160),
  }),
);
export const LoginBody = registry.register('LoginRequest', z.object({ email, password }));
export const EmailBody = z.object({ email });
export const TokenBody = z.object({ token });
export const SecondFactorBody = registry.register(
  'SecondFactorRequest',
  z.object({ code: totpCode.optional(), recoveryCode: recoveryCode.optional() }).refine((v) => !!v.code !== !!v.recoveryCode, {
    message: 'Provide either a code or a recovery code',
  }),
);
export const ResetPasswordBody = registry.register(
  'ResetPasswordRequest',
  z.object({ token, password, code: totpCode.optional(), recoveryCode: recoveryCode.optional() }),
);
export const ChangePasswordBody = z.object({ newPassword: password });
export const StepUpBody = z.object({ password, code: totpCode.optional() });
export const EnableTotpBody = z.object({ code: totpCode });

const Membership = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  role: z.enum(['ORG_OWNER', 'PROPERTY_MANAGER', 'PROPERTY_STAFF', 'READ_ONLY']),
  organizationStatus: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
  permissions: z.array(z.string()),
});

export const MeResponse = registry.register(
  'Me',
  z.object({
    state: z.enum(['anonymous', 'authenticated', 'mfa_pending', 'mfa_enrollment_required']),
    user: z
      .object({
        id: z.uuid(),
        email: z.string(),
        displayName: z.string(),
        platformRole: z.enum(['PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT']).nullable(),
        twoFactorEnabled: z.boolean(),
        twoFactorRequired: z.boolean(),
      })
      .optional(),
    memberships: z.array(Membership).optional(),
    platformPermissions: z.array(z.string()).optional(),
    session: z.object({ id: z.uuid(), expiresAt: z.iso.datetime(), recentAuth: z.boolean() }).optional(),
  }),
);

const ok = (description: string) => ({ description });
const errors = { 400: ok('Validation error'), 401: ok('Not authenticated / invalid credentials'), 403: ok('Forbidden, CSRF or MFA required'), 429: ok('Rate limited') };
const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

const paths: { method: 'get' | 'post' | 'delete'; path: string; summary: string; body?: z.ZodType }[] = [
  { method: 'post', path: '/auth/register', summary: 'Create an account and organization (always 202, no account enumeration)', body: RegisterBody },
  { method: 'post', path: '/auth/verify-email', summary: 'Confirm email with a single-use token', body: TokenBody },
  { method: 'post', path: '/auth/verify-email/resend', summary: 'Send a new verification email (always 202)', body: EmailBody },
  { method: 'post', path: '/auth/login', summary: 'Password sign-in; sets HttpOnly session cookie and CSRF cookie', body: LoginBody },
  { method: 'post', path: '/auth/2fa/verify', summary: 'Second factor for a pending session (TOTP or recovery code)', body: SecondFactorBody },
  { method: 'post', path: '/auth/logout', summary: 'Revoke the current session' },
  { method: 'get', path: '/auth/me', summary: 'Current user, session state, memberships and permissions' },
  { method: 'post', path: '/auth/password/forgot', summary: 'Email a password reset link (always 202)', body: EmailBody },
  { method: 'post', path: '/auth/password/reset', summary: 'Set a new password with a reset token (+2FA code if enabled)', body: ResetPasswordBody },
  { method: 'post', path: '/auth/password/change', summary: 'Change password (recent authentication required)', body: ChangePasswordBody },
  { method: 'post', path: '/auth/step-up', summary: 'Re-confirm password (and 2FA) before sensitive actions', body: StepUpBody },
  { method: 'post', path: '/auth/2fa/setup', summary: 'Start TOTP enrollment; returns secret and QR code' },
  { method: 'post', path: '/auth/2fa/enable', summary: 'Confirm TOTP enrollment; returns recovery codes once', body: EnableTotpBody },
  { method: 'post', path: '/auth/2fa/disable', summary: 'Turn off 2FA (not allowed where mandatory)' },
  { method: 'post', path: '/auth/2fa/recovery-codes', summary: 'Regenerate recovery codes' },
  { method: 'post', path: '/auth/email/change', summary: 'Request an email change (recent auth); confirmation goes to the new address', body: EmailBody },
  { method: 'post', path: '/auth/email/confirm', summary: 'Confirm an email change with the token from the email', body: TokenBody },
  { method: 'get', path: '/auth/sessions', summary: 'List my active sessions' },
  { method: 'delete', path: '/auth/sessions/{sessionId}', summary: 'Revoke one of my sessions' },
  { method: 'post', path: '/auth/sessions/revoke-others', summary: 'Sign out all other sessions' },
];
for (const p of paths) {
  registry.registerPath({
    method: p.method,
    path: `/api/v1${p.path}`,
    tags: ['Auth'],
    summary: p.summary,
    ...(p.body ? { request: { body: json(p.body) } } : {}),
    responses: { 200: p.path === '/auth/me' ? { description: 'OK', ...json(z.object({ data: MeResponse })) } : ok('OK'), 202: ok('Accepted'), ...errors },
  });
}
