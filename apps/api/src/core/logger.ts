// The one pino logger for the API. Secrets (passwords, hashes, auth headers, cookies) are redacted
// here, centrally, so no call site can leak them by accident (CONTRACT §6 Logging).
import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import { env } from '../config/env';

const SECRET_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'temporaryPassword',
  'passwordHash',
  'authorization',
  'cookie',
  'refreshToken',
  'SMTP_PASSWORD',
  'smtpPassword',
  'smtp_password',
  'SMTP_USER',
  'smtpUser',
  'smtp_user',
  'SMTP_CLIENT_SECRET',
  'smtpClientSecret',
  'smtp_client_secret',
  'SMTP_ACCESS_TOKEN',
  'smtpAccessToken',
  'smtp_access_token',
  'SMTP_REFRESH_TOKEN',
  'smtpRefreshToken',
  'smtp_refresh_token',
  'clientSecret',
  'client_secret',
  'accessToken',
  'access_token',
];

export const REDACT_PATHS: string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  ...SECRET_KEYS.map((key) => `*.*.${key}`),
  'auth.pass',
  '*.auth.pass',
  '*.*.auth.pass',
  'auth.user',
  '*.auth.user',
  '*.*.auth.user',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'rhai-api' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger: Logger = createLogger(env.LOG_LEVEL);
