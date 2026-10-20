import { hostname } from 'node:os';
import type { Logger } from 'pino';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../db/prisma.js';
import { withSystem } from '../db/tenant.js';

/**
 * Writes a liveness row for this process every `intervalMs`, so the admin System Health page can show whether
 * background work is running and where. Rows older than a day are removed by the next heartbeat of any process.
 */
export class Heartbeat {
  readonly id = `${hostname()}:${process.pid}`.slice(0, 120);
  private readonly startedAt = new Date();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly role: 'worker' | 'api',
    private readonly version: string,
    private readonly stats: () => Record<string, unknown>,
    private readonly logger: Logger,
  ) {}

  async beat(): Promise<void> {
    const now = new Date();
    const data = { role: this.role, version: this.version.slice(0, 40), lastSeenAt: now, stats: this.stats() as Prisma.InputJsonValue };
    await withSystem(this.db, async (tx) => {
      await tx.workerHeartbeat.upsert({ where: { id: this.id }, create: { id: this.id, startedAt: this.startedAt, ...data }, update: data });
      await tx.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
    });
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    const tick = () => void this.beat().catch((err: unknown) => this.logger.warn({ err: (err as Error).message }, 'heartbeat failed'));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await withSystem(this.db, (tx) => tx.workerHeartbeat.deleteMany({ where: { id: this.id } })).catch(() => undefined);
  }
}
