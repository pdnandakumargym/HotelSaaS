import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Integration tests run against a real PostgreSQL database named by
 * TEST_DATABASE_URL (never DATABASE_URL, so dev data is never touched).
 * Pending Prisma migrations are applied with `prisma migrate deploy`.
 */

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional (CI provides env vars directly)
}

const url = process.env.TEST_DATABASE_URL;
// Migrations need the schema owner; the tests themselves run as the least-privilege app role.
const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL ?? url;
if (!url || !migrationUrl) {
  throw new Error('TEST_DATABASE_URL is not set. Integration tests need a dedicated PostgreSQL database (see apps/api/.env.example).');
}
if (url === process.env.DATABASE_URL || new URL(url).pathname === new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname) {
  throw new Error('TEST_DATABASE_URL must point to a different database than DATABASE_URL; integration tests modify data.');
}

const migrationsDir = join(import.meta.dirname, '../../prisma/migrations');
const expected = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const client = new pg.Client({ connectionString: migrationUrl });
await client.connect();
let applied: string[] = [];
try {
  const res = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  applied = res.rows.map((r) => r.migration_name);
} catch {
  applied = [];
} finally {
  await client.end();
}

if (expected.some((m) => !applied.includes(m))) {
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl, DATABASE_URL: migrationUrl },
    shell: process.platform === 'win32',
  });
}

export default function setup(): void {
  // all work happens at module load (top-level await) so failures abort the run early
}
