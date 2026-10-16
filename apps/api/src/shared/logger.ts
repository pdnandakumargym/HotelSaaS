import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths that must never reach log output. pino's redaction is path-based, so
 * we cover common nesting depths explicitly.
 */
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'secret',
  'totpSecret',
  'totpCode',
  'recoveryCode',
  'recoveryCodes',
  'apiKey',
  'apiPassword',
  'apiUser',
  'apiUsername',
  'authorization',
  'cookie',
  'cardNumber',
  'cvc',
  'cvv',
];

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.Authorization',
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
];

export function createLogger(options: { level: string; pretty?: boolean; name?: string }, destination?: pino.DestinationStream): Logger {
  const config: LoggerOptions = {
    name: options.name ?? 'staysync-api',
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: options.name ?? 'staysync-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  if (options.pretty && !destination) {
    return pino({ ...config, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } });
  }
  return destination ? pino(config, destination) : pino(config);
}
