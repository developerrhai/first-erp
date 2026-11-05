// Reads and validates every environment variable once, so a misconfigured server fails fast at boot
// instead of misbehaving later. Everything else imports the typed `env` object from here.
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DURATION = /^(\d+)(s|m|h)$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** Parses "15m" / "900s" / "1h" into seconds. */
export function parseDurationSeconds(value: string): number {
  const match = DURATION.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * (UNIT_SECONDS[match[2]] ?? 1);
}

/** Maps the TRUST_PROXY string to what Express accepts: boolean, hop count, or address list. */
export function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const DEFAULT_WEB_ORIGIN = 'http://localhost:5173';

/**
 * Splits a comma-separated origin list. An origin is accepted only in canonical form: http(s),
 * host, optional port; no path, query, trailing slash or wildcard (it must equal `new URL(o).origin`).
 */
export function parseOrigins(raw: string | undefined): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const item of (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    let ok = false;
    try {
      const url = new URL(item);
      ok = (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === item;
    } catch {
      ok = false;
    }
    if (ok && !item.includes('*')) {
      if (!origins.includes(item)) origins.push(item);
    } else {
      invalid.push(item);
    }
  }
  return { origins, invalid };
}

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const EMAIL_SENDER_CONFIG_KEYS = {
  Administration: 'EMAIL_FROM_ADMINISTRATION',
  Sales: 'EMAIL_FROM_SALES',
  Purchase: 'EMAIL_FROM_PURCHASE',
  Finance: 'EMAIL_FROM_FINANCE',
  HR: 'EMAIL_FROM_HR',
  Production: 'EMAIL_FROM_PRODUCTION',
  Quality: 'EMAIL_FROM_QUALITY',
  Maintenance: 'EMAIL_FROM_MAINTENANCE',
  Warehouse: 'EMAIL_FROM_WAREHOUSE',
  Projects: 'EMAIL_FROM_PROJECTS',
  Service: 'EMAIL_FROM_SERVICE',
} as const;

export type EmailDepartment = keyof typeof EMAIL_SENDER_CONFIG_KEYS;
type EmailSenderConfigKey = (typeof EMAIL_SENDER_CONFIG_KEYS)[EmailDepartment];

export function isValidSmtpHost(host: string): boolean {
  try {
    const parsed = new URL(`smtp://${host}`);
    return (
      !/[/?#@]/.test(host) &&
      !host.includes('://') &&
      parsed.hostname.length > 0 &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      (parsed.pathname === '' || parsed.pathname === '/') &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

const smtpHostSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    isValidSmtpHost,
    'SMTP_HOST must be a hostname only, without protocol, port, credentials, or path',
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .refine(
        (v) => !/change-me/i.test(v),
        'JWT_ACCESS_SECRET still contains the placeholder "change-me"',
      ),
    ACCESS_TOKEN_TTL: z
      .string()
      .regex(DURATION, 'ACCESS_TOKEN_TTL must look like 15m, 900s or 1h')
      .default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(60).default(10),
    /** Exact CORS allow-list (comma-separated origins). CORS_ORIGINS and WEB_ORIGIN are aliases. */
    WEB_ORIGINS: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),
    WEB_ORIGIN: z.string().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    RATE_LIMIT_DISABLED: booleanString,
    /** Express `trust proxy` value. `loopback` trusts only a proxy on this machine (the Vite dev proxy). */
    TRUST_PROXY: z.string().trim().min(1).default('loopback'),
    /** Max Argon2 hash/verify operations in flight; beyond that requests get 503 SERVER_BUSY. */
    ARGON2_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
    SMTP_HOST: smtpHostSchema.optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    SMTP_AUTH_METHOD: z.enum(['password', 'none']).optional(),
    SMTP_USER: z.string().trim().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    EMAIL_FROM_ADMINISTRATION: z.string().trim().email().optional(),
    EMAIL_FROM_SALES: z.string().trim().email().optional(),
    EMAIL_FROM_PURCHASE: z.string().trim().email().optional(),
    EMAIL_FROM_FINANCE: z.string().trim().email().optional(),
    EMAIL_FROM_HR: z.string().trim().email().optional(),
    EMAIL_FROM_PRODUCTION: z.string().trim().email().optional(),
    EMAIL_FROM_QUALITY: z.string().trim().email().optional(),
    EMAIL_FROM_MAINTENANCE: z.string().trim().email().optional(),
    EMAIL_FROM_WAREHOUSE: z.string().trim().email().optional(),
    EMAIL_FROM_PROJECTS: z.string().trim().email().optional(),
    EMAIL_FROM_SERVICE: z.string().trim().email().optional(),
  })
  .superRefine((value, ctx) => {
    for (const key of ['WEB_ORIGINS', 'CORS_ORIGINS', 'WEB_ORIGIN'] as const) {
      const { invalid } = parseOrigins(value[key]);
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `must be exact origins like https://app.example.com (no path or wildcard); invalid: ${invalid.join(', ')}`,
        });
      }
    }
    if (value.NODE_ENV === 'production' && value.JWT_ACCESS_SECRET.length < 48) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT_ACCESS_SECRET must be at least 48 characters in production',
      });
    }
    if (value.RATE_LIMIT_DISABLED && value.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RATE_LIMIT_DISABLED'],
        message: 'RATE_LIMIT_DISABLED=true is only allowed when NODE_ENV=test',
      });
    }
    const senderKeys = Object.values(EMAIL_SENDER_CONFIG_KEYS) as EmailSenderConfigKey[];
    const senderConfigured = senderKeys.some((key) => value[key] !== undefined);
    const smtpConfigured = [
      value.SMTP_HOST,
      value.SMTP_PORT,
      value.SMTP_SECURE,
      value.SMTP_AUTH_METHOD,
      value.SMTP_USER,
      value.SMTP_PASSWORD,
      ...senderKeys.map((key) => value[key]),
    ].some((setting) => setting !== undefined);
    if (smtpConfigured && !value.SMTP_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when SMTP email settings are provided',
      });
    }
    if (smtpConfigured && !senderConfigured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_FROM_ADMINISTRATION'],
        message: 'At least one department EMAIL_FROM_* sender is required when SMTP is configured',
      });
    }
    if ((value.SMTP_USER === undefined) !== (value.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_USER'],
        message: 'SMTP_USER and SMTP_PASSWORD must be provided together',
      });
    }
    const hasCredentials = value.SMTP_USER !== undefined && value.SMTP_PASSWORD !== undefined;
    if (smtpConfigured && !hasCredentials && value.SMTP_AUTH_METHOD !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_AUTH_METHOD'],
        message:
          'Set SMTP_AUTH_METHOD=none only when the approved relay requires no authentication',
      });
    }
    if (value.SMTP_AUTH_METHOD === 'password' && !hasCredentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_AUTH_METHOD'],
        message: 'SMTP_AUTH_METHOD=password requires SMTP_USER and SMTP_PASSWORD',
      });
    }
    if (value.SMTP_AUTH_METHOD === 'none' && (value.SMTP_USER || value.SMTP_PASSWORD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_AUTH_METHOD'],
        message: 'SMTP_AUTH_METHOD=none cannot be combined with SMTP credentials',
      });
    }
  })
  .transform((value) => ({
    ...value,
    accessTokenTtlSeconds: parseDurationSeconds(value.ACCESS_TOKEN_TTL),
    isProduction: value.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(value.TRUST_PROXY),
    corsOrigins: resolveCorsOrigins(value),
  }));

export type Env = z.infer<typeof envSchema>;

/** Union of WEB_ORIGINS, CORS_ORIGINS and WEB_ORIGIN; the dev default only when none is set. */
function resolveCorsOrigins(value: {
  WEB_ORIGINS?: string;
  CORS_ORIGINS?: string;
  WEB_ORIGIN?: string;
}): string[] {
  const all = [value.WEB_ORIGINS, value.CORS_ORIGINS, value.WEB_ORIGIN].flatMap(
    (raw) => parseOrigins(raw).origins,
  );
  const unique = [...new Set(all)];
  return unique.length > 0 ? unique : [DEFAULT_WEB_ORIGIN];
}

/** Validates a raw environment; throws one readable error listing every problem. */
export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const env: Env = loadEnv(process.env);
