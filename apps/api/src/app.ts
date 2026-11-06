// Builds the Express app (middleware order, routers, error handling) without listening, so tests can
// create isolated instances (e.g. with rate limits on) and server.ts can run the real one.
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './core/http/error-middleware';
import { attachRequestId, genRequestId } from './core/http/request-id';
import { logger } from './core/logger';
import { configureArgon2Concurrency } from './core/auth/argon2-gate';
import {
  createChangePasswordLimiter,
  createGlobalLimiter,
  createLoginIpLimiter,
  createLoginLimiter,
} from './core/rate-limit';
import { createAuthRouter } from './modules/auth/routes';
import { createHealthRouter } from './modules/health/routes';
import type { DbPing } from './modules/health/routes';
import { createMetaRouter } from './modules/meta/routes';
import { createUsersRouter } from './modules/users/routes';
import { createAuditLogsRouter } from './modules/audit-logs/routes';
import { createDepartmentAccessRouter } from './modules/department-access/routes';
import { createDepartmentsRouter } from './modules/departments/routes';
import { createEmailRouter } from './modules/email/routes';
import { createMeRouter } from './modules/me/routes';
import { createModuleControlsRouter } from './modules/module-controls/routes';
import { createPermissionsRouter } from './modules/permissions/routes';
import { createRolesRouter } from './modules/roles/routes';
import { createSettingsRouter } from './modules/settings/routes';
import { createCompanyRouter } from './modules/company/routes';
import { createFinancialYearsRouter } from './modules/financial-years/routes';
import { createLookupsRouter } from './modules/inventory/lookups/routes';
import { createKitLookupsRouter } from './kit/lookups';
import { createKitPanelsRouter } from './kit/panels/routes';
import { createKitCommandsRouter } from './kit/commands';
import { createKitPrintRouter } from './kit/print';
import { createPagesRouter } from './modules/records/routes';
import { createUnitsRouter } from './modules/units/routes';
import { bootKit } from './kit/boot';

export interface AppOptions {
  /** Defaults to !RATE_LIMIT_DISABLED. Tests pass true to exercise the limiter. */
  rateLimit?: boolean;
  dbPing?: DbPing;
  /** Overrides TRUST_PROXY (tests use it to simulate an untrusted peer). */
  trustProxy?: boolean | number | string;
  /** Overrides the CORS allow-list (WEB_ORIGINS / CORS_ORIGINS / WEB_ORIGIN). */
  corsOrigins?: string[];
  /** Overrides ARGON2_MAX_CONCURRENCY (process-wide). */
  argon2Concurrency?: number;
  /** Test hook: mount extra routes before the 404 handler (e.g. a route that throws). */
  extraRoutes?: (app: Express) => void;
}

export function createApp(options: AppOptions = {}): Express {
  const rateLimitEnabled = options.rateLimit ?? !env.RATE_LIMIT_DISABLED;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? env.trustProxy);
  configureArgon2Concurrency(options.argon2Concurrency ?? env.ARGON2_MAX_CONCURRENCY);
  const corsOrigins = options.corsOrigins ?? env.corsOrigins;

  app.use(pinoHttp({ logger, genReqId: genRequestId }));
  app.use(attachRequestId);
  app.use(helmet());
  app.use(
    cors({
      // Exact allow-list only. No Origin header (same-origin, curl, server-to-server) needs no
      // CORS headers; an unlisted origin gets none, so the browser blocks the response.
      origin: (origin, callback) => {
        callback(null, origin !== undefined && corsOrigins.includes(origin) ? origin : false);
      },
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'If-Match',
        'X-Request-Id',
        'X-Unit-Id',
        'X-FY-Id',
      ],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'ETag'],
    }),
  );
  app.use(cookieParser());
  app.use('/api/v1', createGlobalLimiter(rateLimitEnabled));
  app.use('/api/v1/email', createEmailRouter());
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();
  api.use('/health', createHealthRouter(options.dbPing));
  api.use(
    '/auth',
    createAuthRouter({
      loginIpLimiter: createLoginIpLimiter(rateLimitEnabled),
      loginLimiter: createLoginLimiter(rateLimitEnabled),
      changePasswordLimiter: createChangePasswordLimiter(rateLimitEnabled),
    }),
  );
  api.use('/meta', createMetaRouter());
  api.use('/users', createUsersRouter());
  api.use('/me', createMeRouter());
  api.use('/departments', createDepartmentsRouter());
  api.use('/roles', createRolesRouter());
  api.use('/permissions', createPermissionsRouter());
  api.use('/department-access', createDepartmentAccessRouter());
  api.use('/module-controls', createModuleControlsRouter());
  api.use('/settings', createSettingsRouter());
  api.use('/audit-logs', createAuditLogsRouter());
  api.use('/company', createCompanyRouter());
  api.use('/units', createUnitsRouter());
  api.use('/financial-years', createFinancialYearsRouter());
  api.use('/lookups', createLookupsRouter());
  api.use('/lookups', createKitLookupsRouter());
  bootKit(api);
  api.use('/pages', createKitPanelsRouter());
  api.use('/pages', createKitCommandsRouter());
  api.use('/pages', createKitPrintRouter());
  api.use('/pages', createPagesRouter());
  app.use('/api/v1', api);

  options.extraRoutes?.(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
