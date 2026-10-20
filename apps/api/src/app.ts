import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import swaggerUi from 'swagger-ui-express';
import type { AppConfig } from './config/env.js';
import type { Services } from './container.js';
import { csrfProtection, loadSession } from './middleware/auth.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { mediaRouter } from './modules/photos/photos.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { invitationsRouter } from './modules/invitations/invitations.routes.js';
import { organizationsRouter } from './modules/organizations/organizations.routes.js';
import { amenitiesRouter } from './modules/properties/properties.routes.js';
import { plansRouter } from './modules/subscriptions/plans.routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import {
  apiSecurityHeaders,
  corsAllowlist,
  docsSecurityHeaders,
  globalRateLimit,
  rejectUntrustedOrigin,
} from './middleware/security.js';
import './modules/health/health.schemas.js';
import { healthRouter } from './modules/health/health.routes.js';
import type { HealthChecker } from './modules/health/health.service.js';
import { buildOpenApiDocument } from './openapi/document.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  health: HealthChecker;
  /** Database-backed modules (auth, organizations, admin). Omitted in pure HTTP unit tests. */
  services?: Services;
  version?: string;
  /** Requests per minute per client IP across the API. */
  rateLimitPerMinute?: number;
  /** Extra routes mounted under /api/v1 before the 404 handler (used by tests and future modules). */
  registerRoutes?: (api: express.Router) => void;
}

export const API_PREFIX = '/api/v1';

export function createApp(deps: AppDependencies): Express {
  const { config, logger } = deps;
  const version = deps.version ?? '0.1.0';
  const app = express();

  app.disable('x-powered-by');
  // Only trust X-Forwarded-* from the configured proxy topology (never "trust all").
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url?.startsWith(`${API_PREFIX}/health`) ?? false },
    }),
  );

  if (config.apiDocsEnabled) {
    const doc = buildOpenApiDocument(config.appName, version);
    app.get('/api/openapi.json', (_req, res) => {
      res.json(doc);
    });
    app.use('/api/docs', docsSecurityHeaders(), swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: `${config.appName} API` }));
  }

  const api = express.Router();
  api.use(apiSecurityHeaders(config.isProduction));
  api.use(corsAllowlist(config.corsOrigins));
  api.use(rejectUntrustedOrigin(config.corsOrigins));
  api.use(globalRateLimit(deps.rateLimitPerMinute ?? 300));
  api.use(express.json({ limit: config.bodyLimit, strict: true, type: ['application/json'] }));
  api.use(cookieParser());

  api.use('/health', healthRouter(config, deps.health, version));
  if (deps.services) {
    const s = deps.services;
    api.use(loadSession(s.sessions, config));
    api.use(csrfProtection());
    api.use('/media', mediaRouter(s.photos));
    api.use('/auth', authRouter({ config, auth: s.auth, sessions: s.sessions, limits: s.limits }));
    api.use('/organizations', organizationsRouter({ db: s.db, config, audit: s.audit, invitations: s.invitations, support: s.support, integrations: s.integrations, connections: s.connections, reservations: s.reservations, discrepancies: s.discrepancies, photos: s.photos, reports: s.reports, providers: s.providers }));
    api.use('/invitations', invitationsRouter({ config, invitations: s.invitations, limits: s.limits }));
    api.use('/amenities', amenitiesRouter());
    api.use('/plans', plansRouter(s.db));
    api.use('/admin', adminRouter({ db: s.db, config, audit: s.audit, support: s.support, integrations: s.integrations, reservations: s.reservations, version }));
  }
  deps.registerRoutes?.(api);
  api.use(notFoundHandler());

  app.use(API_PREFIX, api);
  app.use(apiSecurityHeaders(config.isProduction), notFoundHandler());
  app.use(errorHandler(logger));

  return app;
}
