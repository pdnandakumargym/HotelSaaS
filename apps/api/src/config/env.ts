import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once at startup. Error messages name the offending variable but
 * never echo its value, so secrets cannot leak into logs via config errors.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** Express `trust proxy` setting. "true" (trust everything) is deliberately not accepted. */
export type TrustProxySetting = false | number | string[];

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function parseTrustProxy(raw: string, ctx: z.RefinementCtx): TrustProxySetting {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '*') {
    ctx.addIssue({
      code: 'custom',
      message: 'TRUST_PROXY=true trusts every hop and allows client-IP spoofing; use a hop count or proxy IP/CIDR list',
    });
    return z.NEVER;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 10) {
      ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY hop count looks wrong (>10)' });
      return z.NEVER;
    }
    return hops;
  }
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [addr, prefix] = entry.split('/');
    const validAddr = PROXY_KEYWORDS.has(entry) || (addr !== undefined && isIP(addr) !== 0);
    const validPrefix = prefix === undefined || /^\d{1,3}$/.test(prefix);
    if (!validAddr || !validPrefix) {
      ctx.addIssue({ code: 'custom', message: `TRUST_PROXY entry is not an IP, CIDR or keyword: ${entry}` });
      return z.NEVER;
    }
  }
  return entries;
}

function parseOrigins(raw: string, ctx: z.RefinementCtx): string[] {
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const result: string[] = [];
  for (const origin of origins) {
    if (origin === '*' || origin.includes('*')) {
      ctx.addIssue({ code: 'custom', message: 'CORS_ORIGINS must list explicit origins; wildcards are not allowed' });
      return z.NEVER;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      ctx.addIssue({ code: 'custom', message: `CORS_ORIGINS entry is not a valid origin: ${origin}` });
      return z.NEVER;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.replace(/\/$/, '')) {
      ctx.addIssue({
        code: 'custom',
        message: `CORS_ORIGINS entry must be scheme://host[:port] with no path: ${origin}`,
      });
      return z.NEVER;
    }
    result.push(url.origin);
  }
  return result;
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().min(1).max(60).default('StaySync'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
      .min(1, 'DATABASE_URL is required')
      .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgresql:// connection string'),

    CORS_ORIGINS: z.string().default('').transform(parseOrigins),
    TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(b|kb|mb)$/i, 'BODY_LIMIT must look like 100kb or 1mb')
      .default('100kb'),
    API_DOCS_ENABLED: booleanString.optional(),

    APP_BASE_URL: z
      .url({ error: 'APP_BASE_URL must be a URL' })
      .default('http://localhost:4200')
      .transform((v) => v.replace(/\/+$/, '')),

    // Auth & security
    DATA_ENCRYPTION_KEY: z
      .string({ error: 'DATA_ENCRYPTION_KEY is required (32 random bytes, base64). Run scripts/setup-windows.ps1 or see .env.example' })
      .refine((v) => {
        try {
          return Buffer.from(v, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60 * 7).default(720),
    COOKIE_SECURE: booleanString.optional(),
    STEP_UP_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    OWNER_2FA_POLICY: z.enum(['optional', 'required']).default('optional'),
    AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).max(20).default(5),
    AUTH_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
    AUTH_LOCKOUT_MAX_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
    AUTH_FAILURE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    NOTIFY_SUSPICIOUS_ACTIVITY: booleanString.default(true),
    ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).max(1048576).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(2),

    // Email
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().min(3).default('StaySync <no-reply@staysync.local>'),

    ZODOMUS_ENABLED: booleanString.default(false),
    ZODOMUS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
    ZODOMUS_BASE_URL: z
      .url({ error: 'ZODOMUS_BASE_URL must be a URL' })
      .refine((v) => v.startsWith('https://'), 'ZODOMUS_BASE_URL must use https')
      .default('https://api.zodomus.com'),
    ZODOMUS_API_USERNAME: z.string().optional(),
    ZODOMUS_API_PASSWORD: z.string().optional(),
    ZODOMUS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    /** Production inventory changes need an explicit opt-in. Sandbox writes are always allowed when Zodomus is enabled. */
    ZODOMUS_ALLOW_PRODUCTION_WRITES: booleanString.default(false),
    /** Background worker that sends queued availability/rate updates. Off in tests (they run it explicitly). */
    SYNC_WORKER_ENABLED: booleanString.optional(),
    SYNC_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600000).default(5000),
    /** How far ahead a full sync sends availability and rates (channels recommend one year). */
    SYNC_HORIZON_DAYS: z.coerce.number().int().min(30).max(400).default(365),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production';

    if (isProd) {
      for (const origin of env.CORS_ORIGINS) {
        if (!origin.startsWith('https://')) {
          ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'production CORS origins must use https' });
        }
      }
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'CORS_ORIGINS must be set in production' });
      }
    }

    if (isProd) {
      if (!env.APP_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'must use https in production' });
      }
      if (env.COOKIE_SECURE === false) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'cookies must be Secure in production' });
      }
      if (env.MAIL_TRANSPORT === 'log') {
        ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'log transport is for development only' });
      }
      if (env.ARGON2_MEMORY_KIB < 19456) {
        ctx.addIssue({ code: 'custom', path: ['ARGON2_MEMORY_KIB'], message: 'must be at least 19456 (19 MiB) in production' });
      }
    }
    if (env.AUTH_LOCKOUT_MAX_SECONDS < env.AUTH_LOCKOUT_BASE_SECONDS) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_LOCKOUT_MAX_SECONDS'], message: 'must be >= AUTH_LOCKOUT_BASE_SECONDS' });
    }

    if (env.ZODOMUS_ENABLED) {
      if (!env.ZODOMUS_API_USERNAME?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['ZODOMUS_API_USERNAME'], message: 'required when ZODOMUS_ENABLED=true' });
      }
      if (!env.ZODOMUS_API_PASSWORD?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['ZODOMUS_API_PASSWORD'], message: 'required when ZODOMUS_ENABLED=true' });
      }
      if (isProd && env.ZODOMUS_ENVIRONMENT === 'sandbox') {
        ctx.addIssue({
          code: 'custom',
          path: ['ZODOMUS_ENVIRONMENT'],
          message: 'sandbox Zodomus configuration is not allowed when NODE_ENV=production',
        });
      }
    }
    if (!isProd && env.ZODOMUS_ENVIRONMENT === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['ZODOMUS_ENVIRONMENT'],
        message: 'production Zodomus access is only allowed when NODE_ENV=production',
      });
    }
  });

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly appName: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: TrustProxySetting;
  readonly bodyLimit: string;
  readonly apiDocsEnabled: boolean;
  readonly appBaseUrl: string;
  readonly auth: {
    readonly dataEncryptionKey: Buffer;
    readonly sessionTtlMs: number;
    readonly sessionIdleMs: number;
    readonly cookieSecure: boolean;
    readonly stepUpWindowMs: number;
    readonly owner2faPolicy: 'optional' | 'required';
    readonly lockoutThreshold: number;
    readonly lockoutBaseMs: number;
    readonly lockoutMaxMs: number;
    readonly failureWindowMs: number;
    readonly notifySuspiciousActivity: boolean;
    readonly argon2: { readonly memoryCost: number; readonly timeCost: number };
  };
  readonly mail: {
    readonly transport: 'smtp' | 'log';
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly password: string | undefined;
    readonly from: string;
  };
  readonly zodomus: {
    readonly enabled: boolean;
    readonly environment: 'sandbox' | 'production';
    readonly baseUrl: string;
    readonly timeoutMs: number;
    /** True when both credentials are present. The values themselves are never exposed via config summaries. */
    readonly credentialsConfigured: boolean;
    readonly username: string | undefined;
    readonly password: string | undefined;
    readonly allowProductionWrites: boolean;
  };
  readonly sync: {
    readonly workerEnabled: boolean;
    readonly intervalMs: number;
    readonly horizonDays: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as "unset" so blank lines in .env fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const key = i.path.join('.') || 'env';
      return `${key}: ${i.message}`;
    });
    throw new ConfigError(issues);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction,
    appName: env.APP_NAME,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: Object.freeze([...env.CORS_ORIGINS]),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT,
    apiDocsEnabled: env.API_DOCS_ENABLED ?? !isProduction,
    appBaseUrl: env.APP_BASE_URL,
    auth: Object.freeze({
      dataEncryptionKey: Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64'),
      sessionTtlMs: env.SESSION_TTL_HOURS * 3_600_000,
      sessionIdleMs: env.SESSION_IDLE_MINUTES * 60_000,
      cookieSecure: env.COOKIE_SECURE ?? isProduction,
      stepUpWindowMs: env.STEP_UP_WINDOW_MINUTES * 60_000,
      owner2faPolicy: env.OWNER_2FA_POLICY,
      lockoutThreshold: env.AUTH_LOCKOUT_THRESHOLD,
      lockoutBaseMs: env.AUTH_LOCKOUT_BASE_SECONDS * 1000,
      lockoutMaxMs: env.AUTH_LOCKOUT_MAX_SECONDS * 1000,
      failureWindowMs: env.AUTH_FAILURE_WINDOW_MINUTES * 60_000,
      notifySuspiciousActivity: env.NOTIFY_SUSPICIOUS_ACTIVITY,
      argon2: Object.freeze({ memoryCost: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST }),
    }),
    mail: Object.freeze({
      transport: env.MAIL_TRANSPORT,
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    }),
    zodomus: Object.freeze({
      enabled: env.ZODOMUS_ENABLED,
      environment: env.ZODOMUS_ENVIRONMENT,
      baseUrl: env.ZODOMUS_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: env.ZODOMUS_TIMEOUT_MS,
      credentialsConfigured: Boolean(env.ZODOMUS_API_USERNAME?.trim() && env.ZODOMUS_API_PASSWORD?.trim()),
      username: env.ZODOMUS_API_USERNAME,
      password: env.ZODOMUS_API_PASSWORD,
      allowProductionWrites: env.ZODOMUS_ALLOW_PRODUCTION_WRITES,
    }),
    sync: Object.freeze({
      workerEnabled: env.SYNC_WORKER_ENABLED ?? env.NODE_ENV !== 'test',
      intervalMs: env.SYNC_WORKER_INTERVAL_MS,
      horizonDays: env.SYNC_HORIZON_DAYS,
    }),
  });
}
