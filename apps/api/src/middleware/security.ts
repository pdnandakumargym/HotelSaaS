import cors, { type CorsOptions } from 'cors';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { errorBody } from '../shared/http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Strict headers for JSON API responses. */
export function apiSecurityHeaders(isProduction: boolean): RequestHandler {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
}

/** Helmet defaults (self-hosted scripts/styles) for the Swagger UI page. */
export function docsSecurityHeaders(): RequestHandler {
  return helmet();
}

/**
 * Credentialed CORS with an explicit allowlist. Requests without an Origin
 * header (curl, server-to-server, same-origin navigation) are not CORS requests
 * and pass through; authorization still applies to them.
 */
export function corsAllowlist(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  const options: CorsOptions = {
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  };
  return cors(options);
}

/**
 * Defense in depth on top of CORS: a browser request from a non-allowlisted
 * origin must not be able to change state even if CORS would only block the
 * response from being read.
 */
export function rejectUntrustedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (origin !== undefined && !allowed.has(origin)) {
      if (!SAFE_METHODS.has(req.method)) {
        res.status(403).json(errorBody('ORIGIN_NOT_ALLOWED', 'Request origin is not allowed', req.requestId));
        return;
      }
    }
    next();
  };
}

/** Coarse per-IP limiter for the whole API. Endpoint-specific limits (login, reset, 2FA) are added in Milestone 2. */
export function globalRateLimit(limit = 300): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json(errorBody('RATE_LIMITED', 'Too many requests, please slow down', req.requestId));
    },
  });
}
