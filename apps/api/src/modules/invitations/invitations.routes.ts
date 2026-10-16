import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { registry } from '../../openapi/registry.js';
import { sendData } from '../../shared/http.js';
import { parseBody } from '../../shared/validate.js';
import { requestMeta } from '../auth/auth.routes.js';
import type { AuthRateLimits } from '../auth/rate-limits.js';
import { setSessionCookies } from '../auth/session.service.js';
import { PASSWORD_MAX_LENGTH } from '../auth/password.js';
import type { InvitationService } from './invitation.service.js';

const TokenBody = z.object({ token: z.string().min(20).max(200) });
const RegisterBody = z.object({ token: z.string().min(20).max(200), displayName: z.string().trim().min(1).max(120), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

for (const [path, summary] of [
  ['/invitations/preview', 'What an invitation link is for (token in body)'],
  ['/invitations/accept', 'Accept as the signed-in user (email must match)'],
  ['/invitations/register', 'Create an account from an invitation and sign in'],
] as const) {
  registry.registerPath({ method: 'post', path: `/api/v1${path}`, tags: ['Invitations'], summary, responses: { 200: { description: 'OK' }, 400: { description: 'Invalid or expired' } } });
}

/** Public invitation endpoints. Tokens travel in request bodies, never in URLs. */
export function invitationsRouter(deps: { config: AppConfig; invitations: InvitationService; limits: AuthRateLimits }): Router {
  const { config, invitations, limits } = deps;
  const r = Router();

  r.post('/preview', limits.tokenSubmit, async (req, res) => {
    const { token } = parseBody(TokenBody, req);
    sendData(res, await invitations.preview(token));
  });

  r.post('/accept', limits.tokenSubmit, requireAuth(['authenticated', 'mfa_enrollment_required']), async (req, res) => {
    const { token } = parseBody(TokenBody, req);
    sendData(res, await invitations.accept(token, req.auth!.user, requestMeta(req)));
  });

  r.post('/register', limits.register, async (req, res) => {
    const body = parseBody(RegisterBody, req);
    const issued = await invitations.registerAndAccept(body.token, body, requestMeta(req));
    setSessionCookies(res, config, issued);
    sendData(res, { status: 'joined' }, 201);
  });

  return r;
}
