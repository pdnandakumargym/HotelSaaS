import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export type Database = PrismaClient;

export interface DatabaseOptions {
  connectionString: string;
  /** Max pool size; keep small in dev. */
  max?: number;
  /** Fail fast instead of hanging when the DB is unreachable. */
  connectionTimeoutMillis?: number;
  /** Abort runaway statements server-side. */
  statementTimeoutMillis?: number;
}

export function createDatabase(options: DatabaseOptions): Database {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    statement_timeout: options.statementTimeoutMillis ?? 15_000,
    application_name: 'staysync-api',
  });
  return new PrismaClient({ adapter });
}
