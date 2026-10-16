import type { Logger } from 'pino';
import type { AppConfig } from './config/env.js';
import type { Database } from './infrastructure/db/prisma.js';
import type { Mailer } from './infrastructure/mail/mailer.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { Argon2PasswordHasher, type PasswordHasher } from './modules/auth/password.js';
import { createAuthRateLimits, type AuthRateLimitOptions, type AuthRateLimits } from './modules/auth/rate-limits.js';
import { SessionService } from './modules/auth/session.service.js';
import { InvitationService } from './modules/invitations/invitation.service.js';
import { SupportAccessService } from './modules/support/support-access.service.js';
import type { ChannelProvider } from './modules/channels/channel-provider.js';
import { DbCallRecorder, IntegrationService } from './modules/channels/integration.service.js';
import { ZodomusAdapter } from './modules/channels/zodomus/zodomus.adapter.js';
import { ChannelConnectionService } from './modules/channels/connection.service.js';
import { SyncWorker } from './modules/channels/sync.service.js';

/** Composition root: wires concrete implementations to the interfaces the modules depend on. */
export interface Services {
  db: Database;
  mailer: Mailer;
  hasher: PasswordHasher;
  audit: AuditService;
  sessions: SessionService;
  auth: AuthService;
  limits: AuthRateLimits;
  invitations: InvitationService;
  support: SupportAccessService;
  integrations: IntegrationService;
  connections: ChannelConnectionService;
  syncWorker: SyncWorker;
}

export function createServices(
  input: {
    db: Database;
    config: AppConfig;
    logger: Logger;
    mailer: Mailer;
    rateLimits?: AuthRateLimitOptions;
    now?: () => number;
    /** Override the channel provider (tests use a fake; never the real API). */
    channelProvider?: ChannelProvider;
  },
): Services {
  const { db, config, logger, mailer } = input;
  const hasher = new Argon2PasswordHasher(config.auth.argon2);
  const audit = new AuditService(db, logger);
  const sessions = new SessionService(db, config);
  const auth = new AuthService(db, config, hasher, sessions, mailer, audit, logger, input.now);
  const invitations = new InvitationService(db, config, mailer, audit, hasher, sessions);
  const support = new SupportAccessService(db, config, mailer, audit);
  const provider = input.channelProvider ?? new ZodomusAdapter(config.zodomus, logger, new DbCallRecorder(db));
  const integrations = new IntegrationService(db, provider, audit, input.now);
  const connections = new ChannelConnectionService(db, config, provider, audit);
  const syncWorker = new SyncWorker(db, provider, logger, input.now);
  return { db, mailer, hasher, audit, sessions, auth, limits: createAuthRateLimits(input.rateLimits), invitations, support, integrations, connections, syncWorker };
}
