import type { Database } from '../../infrastructure/db/prisma.js';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

/** Abstraction so the HTTP layer and tests do not depend on Prisma. */
export interface HealthChecker {
  checkDatabase(): Promise<DependencyStatus>;
}

export class PrismaHealthChecker implements HealthChecker {
  constructor(
    private readonly db: Database,
    private readonly timeoutMs = 2_000,
  ) {}

  async checkDatabase(): Promise<DependencyStatus> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.db.$queryRaw`SELECT 1`,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('database health check timed out')), this.timeoutMs);
        }),
      ]);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
