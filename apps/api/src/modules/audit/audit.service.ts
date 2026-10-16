import type { Logger } from 'pino';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, type Tx } from '../../infrastructure/db/tenant.js';
import type { Prisma } from '../../generated/prisma/client.js';

export interface AuditContext {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEntry extends AuditContext {
  action: string;
  organizationId?: string | null;
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'anonymous';
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

const FORBIDDEN_METADATA_KEYS = /pass(word)?|secret|token|code|otp|authorization|cookie/i;

/** Append-only audit log. Metadata keys that look like secrets are dropped, never stored. */
export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    const data = {
      action: entry.action,
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorType: entry.actorType ?? (entry.actorUserId ? 'user' : 'system'),
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      requestId: entry.requestId ?? null,
      ipAddress: normalizeIp(entry.ipAddress),
      userAgent: entry.userAgent?.slice(0, 400) ?? null,
      metadata: sanitize(entry.metadata ?? {}) as Prisma.InputJsonValue,
    };
    try {
      if (tx) await tx.auditEvent.create({ data });
      else await withSystem(this.db, (t) => t.auditEvent.create({ data }));
    } catch (err) {
      // Auditing must not take the request down, but the failure itself is logged loudly.
      this.logger.error({ err, action: entry.action }, 'failed to write audit event');
      if (tx) throw err;
    }
  }
}

function sanitize(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_METADATA_KEYS.test(k)) continue;
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? sanitize(v as Record<string, unknown>) : v;
  }
  return out;
}

function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
