import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations run as the schema OWNER (MIGRATION_DATABASE_URL). The API itself connects with
// DATABASE_URL as the least-privilege role "staysync_app", which row-level security applies to.
// Values are read lazily so `prisma generate` works without a database.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
    // Only needed for `prisma migrate diff --from-migrations` (drift check in CI).
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
