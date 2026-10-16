import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sha256Hex } from '../../shared/crypto.js';
import { errorBody } from '../../shared/http.js';

export interface AuthRateLimitOptions {
  /** Multiplies every limit (tests use small or large values). */
  scale?: number;
  disabled?: boolean;
}

const pass: RequestHandler = (_req, _res, next) => next();

function emailKey(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  // Hash so the in-memory store does not hold email addresses.
  return `email:${sha256Hex(email)}`;
}

function ipKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

function sessionOrIpKey(req: Request): string {
  return req.auth ? `session:${req.auth.session.id}` : ipKey(req);
}

function limiter(name: string, windowMs: number, limit: number, keyGenerator: (req: Request) => string, opts: AuthRateLimitOptions): RequestHandler {
  if (opts.disabled) return pass;
  return rateLimit({
    windowMs,
    limit: Math.max(1, Math.round(limit * (opts.scale ?? 1))),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: name,
    keyGenerator,
    handler: (req, res) => {
      res.status(429).json(errorBody('RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.', req.requestId));
    },
  });
}

/**
 * Endpoint-specific limits. Per-IP limits slow down a single client; per-account (email)
 * limits slow down distributed attacks on one account and apply equally to unknown emails,
 * so they reveal nothing about which accounts exist. The durable account lockout lives in the database.
 * Stores are in-memory (single API instance); use a shared store when scaling out.
 */
export function createAuthRateLimits(opts: AuthRateLimitOptions = {}) {
  const MIN = 60_000;
  return {
    loginIp: limiter('login-ip', 15 * MIN, 30, ipKey, opts),
    loginAccount: limiter('login-account', 15 * MIN, 10, emailKey, opts),
    register: limiter('register-ip', 60 * MIN, 10, ipKey, opts),
    forgotIp: limiter('forgot-ip', 15 * MIN, 10, ipKey, opts),
    forgotAccount: limiter('forgot-account', 60 * MIN, 3, emailKey, opts),
    resendAccount: limiter('resend-account', 60 * MIN, 3, emailKey, opts),
    tokenSubmit: limiter('token-submit-ip', 15 * MIN, 20, ipKey, opts),
    secondFactor: limiter('mfa', 5 * MIN, 10, sessionOrIpKey, opts),
    stepUp: limiter('step-up', 15 * MIN, 10, sessionOrIpKey, opts),
  };
}
export type AuthRateLimits = ReturnType<typeof createAuthRateLimits>;
