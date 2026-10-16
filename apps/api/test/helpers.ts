import { Writable } from 'node:stream';
import type { AppConfig } from '../src/config/env.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/shared/logger.js';
import type { HealthChecker } from '../src/modules/health/health.service.js';

export const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  CORS_ORIGINS: 'http://localhost:4200,https://app.example.test',
  LOG_LEVEL: 'silent',
  // Fixed, test-only key (all zero bytes would be rejected by nothing, but be explicit it is fake).
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAIL_TRANSPORT: 'log',
  ARGON2_MEMORY_KIB: '1024',
  ARGON2_TIME_COST: '1',
} as const;

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

/** Logger that writes JSON lines into an array so tests can assert on log output. */
export function memoryLogger(level = 'info') {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  const logger = createLogger({ level, name: 'test' }, stream);
  return { logger, lines };
}

export function fakeHealth(status: 'up' | 'down' = 'up'): HealthChecker {
  return { checkDatabase: () => Promise.resolve({ status, latencyMs: 1 }) };
}
