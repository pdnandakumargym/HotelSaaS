import type { Database } from './prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction scoped to one organization. PostgreSQL row-level security
 * then only exposes that organization's rows, even if a query forgets its filter.
 */
export function withTenant<T>(db: Database, organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(organizationId)) throw new Error('withTenant requires a UUID organization id');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction that bypasses tenant RLS. Only for system work that is not
 * acting for a single tenant: authentication lookups, platform-admin views, background jobs.
 * Callers must still apply their own authorization.
 */
export function withSystem<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
    return fn(tx);
  });
}
