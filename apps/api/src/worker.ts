/**
 * Background worker process: sends queued availability/rate updates and fetches reservations.
 * Run it as a separate process in production (API with SYNC_WORKER_ENABLED=false), or let the API run the
 * same loops itself (the default for local development). Several workers are safe: jobs are claimed with
 * FOR UPDATE SKIP LOCKED.
 */
import { createServices } from './container.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDatabase } from './infrastructure/db/prisma.js';
import { createMailer } from './infrastructure/mail/mailer.js';
import { Heartbeat } from './infrastructure/workers/heartbeat.js';
import { createLogger } from './shared/logger.js';

const VERSION = process.env.npm_package_version ?? process.env.APP_VERSION ?? '0.1.0';

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
const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' }).child({ process: 'worker' });
const db = createDatabase({ connectionString: config.databaseUrl, max: 5 });
const services = createServices({ db, config, logger, mailer: createMailer(config, logger) });
const heartbeat = new Heartbeat(db, 'worker', VERSION, () => ({ sync: services.syncWorker.stats(), reservations: services.reservations.stats() }), logger);

services.syncWorker.start(config.sync.intervalMs);
services.reservations.start(config.sync.reservationPollMs);
services.reservations.startRetention();
heartbeat.start();
logger.info({ syncIntervalMs: config.sync.intervalMs, reservationPollMs: config.sync.reservationPollMs, zodomus: { enabled: config.zodomus.enabled, environment: config.zodomus.environment } }, `${config.appName} worker started`);
// Keep the process alive (the loops' timers are unref'd so the API can exit cleanly).
const keepAlive = setInterval(() => undefined, 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down');
  clearInterval(keepAlive);
  services.syncWorker.stop();
  services.reservations.stop();
  await heartbeat.stop();
  await db.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
