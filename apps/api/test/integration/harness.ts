import request from 'supertest';
import type { Response } from 'supertest';
import { createApp } from '../../src/app.js';
import { createServices, type Services } from '../../src/container.js';
import { createDatabase, type Database } from '../../src/infrastructure/db/prisma.js';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { MemoryMailer } from '../../src/infrastructure/mail/mailer.js';
import { createDefaultSubscription } from '../../src/modules/subscriptions/plan-limits.js';
import type { OrganizationRole, PlatformRole } from '../../src/generated/prisma/enums.js';
import { DbCallRecorder } from '../../src/modules/channels/integration.service.js';
import { ZodomusAdapter } from '../../src/modules/channels/zodomus/zodomus.adapter.js';
import type { FetchLike } from '../../src/modules/channels/zodomus/zodomus.client.js';
import { fakeHealth, memoryLogger, testConfig } from '../helpers.js';

export const ORIGIN = 'http://localhost:4200';
export const STRONG_PASSWORD = 'correct horse battery staple';

export interface Harness {
  db: Database;
  mailer: MemoryMailer;
  services: Services;
  app: ReturnType<typeof createApp>;
  clock: { offsetMs: number };
  logLines: string[];
  client(): Client;
  uniqueEmail(tag?: string): string;
  createUser(opts?: { role?: OrganizationRole; organizationId?: string; platformRole?: PlatformRole; verified?: boolean; password?: string }): Promise<{
    id: string;
    email: string;
    password: string;
    organizationId: string | null;
  }>;
  createOrg(name?: string): Promise<{ id: string }>;
  close(): Promise<void>;
}

/** HTTP client that keeps cookies and echoes the CSRF cookie in X-CSRF-Token, like the SPA. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly app: Harness['app']) {}

  get csrf(): string | undefined {
    return this.cookies.get('ss_csrf');
  }
  get sessionToken(): string | undefined {
    return this.cookies.get('ss_session');
  }
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  private capture(res: Response): Response {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const c of raw ?? []) {
      const [pair, ...attrs] = c.split(';');
      const [name, ...v] = pair!.split('=');
      const value = v.join('=');
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim())) || value === '';
      if (expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    return res;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const r = request(this.app).get(`/api/v1${path}`).set('Cookie', this.cookieHeader()).set(headers);
    return this.capture(await r);
  }

  async send(method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, opts: { csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    let r = request(this.app)[method](`/api/v1${path}`).set('Origin', ORIGIN).set('Cookie', this.cookieHeader());
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf) r = r.set('X-CSRF-Token', csrf);
    if (opts.headers) r = r.set(opts.headers);
    return this.capture(await (body === undefined ? r : r.send(body as object)));
  }

  post(path: string, body?: unknown, opts?: { csrf?: string | null; headers?: Record<string, string> }) {
    return this.send('post', path, body ?? {}, opts);
  }

  async login(email: string, password: string): Promise<Response> {
    return this.post('/auth/login', { email, password });
  }
}

const noNetwork: FetchLike = () => Promise.reject(new Error('Network access is disabled in tests'));

/**
 * `channelFetch` replaces the network for the Zodomus adapter. Integration tests never call the
 * real Zodomus API (and so can never touch real inventory).
 */
export function createHarness(overrides: Record<string, string> = {}, opts: { channelFetch?: FetchLike } = {}): Promise<Harness> {
  const db = createDatabase({ connectionString: process.env.TEST_DATABASE_URL!, max: 5 });
  const mailer = new MemoryMailer();
  const clock = { offsetMs: 0 };
  const { logger, lines } = memoryLogger('info');
  const config = testConfig({ LOG_LEVEL: 'info', TRUST_PROXY: 'loopback', ...overrides });
  const channelProvider = new ZodomusAdapter(config.zodomus, logger, new DbCallRecorder(db), opts.channelFetch ?? noNetwork, { backoffMs: 0 });
  const services = createServices({ db, config, logger, mailer, rateLimits: { disabled: true }, now: () => Date.now() + clock.offsetMs, channelProvider });
  const app = createApp({ config, logger, health: fakeHealth(), services });
  const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let n = 0;

  const h: Harness = {
    db,
    mailer,
    services,
    app,
    clock,
    logLines: lines,
    client: () => new Client(app),
    uniqueEmail: (tag = 'user') => `${tag}-${run}-${++n}@example.test`,
    async createOrg(name = 'Test Org') {
      return withSystem(db, async (tx) => {
        const org = await tx.organization.create({ data: { name, slug: `t-${run}-${++n}` }, select: { id: true } });
        await createDefaultSubscription(tx, org.id);
        return org;
      });
    },
    async createUser(opts = {}) {
      const email = h.uniqueEmail(opts.platformRole ? 'admin' : (opts.role ?? 'owner').toLowerCase().replace('_', '-'));
      const password = opts.password ?? STRONG_PASSWORD;
      const passwordHash = await services.hasher.hash(password);
      return withSystem(db, async (tx) => {
        const user = await tx.user.create({
          data: { email, displayName: 'Test User', passwordHash, platformRole: opts.platformRole ?? null, emailVerifiedAt: opts.verified === false ? null : new Date() },
        });
        let organizationId: string | null = null;
        if (opts.platformRole === undefined || opts.role || opts.organizationId) {
          if (!opts.organizationId) {
            organizationId = (await tx.organization.create({ data: { name: 'Test Org', slug: `t-${run}-${++n}` } })).id;
            await createDefaultSubscription(tx, organizationId);
          } else organizationId = opts.organizationId;
          await tx.organizationMembership.create({ data: { organizationId, userId: user.id, role: opts.role ?? 'ORG_OWNER' } });
        }
        return { id: user.id, email, password, organizationId };
      });
    },
    async close() {
      await db.$disconnect();
    },
  };
  return Promise.resolve(h);
}

/** Extracts the one-time token from an email body (the part after #token=). */
export function tokenFrom(text: string | undefined): string {
  const m = /#token=([A-Za-z0-9_-]+)/.exec(text ?? '');
  if (!m) throw new Error(`no token in email: ${text}`);
  return m[1]!;
}

export function bodyWithoutRequestId(res: Response): unknown {
  const b = structuredClone(res.body as { error?: { requestId?: string } });
  if (b.error) delete b.error.requestId;
  return b;
}
