import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createServices } from './container.js';
import { createMailer } from './infrastructure/mail/mailer.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDatabase } from './infrastructure/db/prisma.js';
import { PrismaHealthChecker } from './modules/health/health.service.js';
import { createLogger } from './shared/logger.js';
import { Heartbeat } from './infrastructure/workers/heartbeat.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee apps/api/.env.example\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' });
  const db = createDatabase({ connectionString: config.databaseUrl });
  const health = new PrismaHealthChecker(db);

  const dbStatus = await health.checkDatabase();
  if (dbStatus.status === 'down') {
    logger.warn('PostgreSQL is not reachable yet; /api/v1/health/ready will report not_ready until it is');
  }

  const services = createServices({ db, config, logger, mailer: createMailer(config, logger) });
  const app = createApp({ config, logger, health, services, version: VERSION });
  // Background loops run inside the API unless a separate worker process is used (SYNC_WORKER_ENABLED=false).
  const heartbeat = new Heartbeat(db, 'api', VERSION, () => ({ sync: services.syncWorker.stats(), reservations: services.reservations.stats() }), logger);
  if (config.sync.workerEnabled) {
    services.syncWorker.start(config.sync.intervalMs);
    services.reservations.start(config.sync.reservationPollMs);
    services.reservations.startRetention();
    heartbeat.start();
  }
  const server = createServer(app);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  server.listen(config.port, config.host, () => {
    logger.info(
      {
        url: `http://${config.host}:${config.port}/api/v1/health`,
        env: config.nodeEnv,
        corsOrigins: config.corsOrigins,
        trustProxy: config.trustProxy,
        docs: config.apiDocsEnabled ? `http://${config.host}:${config.port}/api/docs` : 'disabled',
        zodomus: {
          enabled: config.zodomus.enabled,
          environment: config.zodomus.environment,
          credentialsConfigured: config.zodomus.credentialsConfigured,
        },
      },
      `${config.appName} API listening`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    services.syncWorker.stop();
    services.reservations.stop();
    void heartbeat.stop();
    server.close(() => {
      void db.$disconnect().finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

void main();
