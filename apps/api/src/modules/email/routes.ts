import express from 'express';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { authenticate, requirePasswordChanged } from '../../core/auth/authenticate';
import { asyncHandler } from '../../core/http/async-handler';
import type { sendEmailForAuthenticatedUser } from '../../core/email/email-service';
import { validate } from '../../core/http/validate';
import { createRequireEmailSend } from '../../core/rbac/email-send';
import type { EmailSendPermissionLookup } from '../../core/rbac/email-send';
import { emailController } from './controller';
import { emailSendBodySchema } from './schemas';

const EMAIL_BODY_LIMIT = '29mb';

export interface EmailRouterDependencies {
  authenticate?: RequestHandler;
  permissionLookup?: EmailSendPermissionLookup;
  sendEmail?: typeof sendEmailForAuthenticatedUser;
}

export function createEmailRouter(deps: EmailRouterDependencies = {}): Router {
  const router = Router();
  router.post(
    '/send',
    deps.authenticate ?? authenticate,
    requirePasswordChanged,
    createRequireEmailSend(deps.permissionLookup),
    express.json({ limit: EMAIL_BODY_LIMIT }),
    validate({ body: emailSendBodySchema }),
    asyncHandler(emailController.send(deps.sendEmail)),
  );
  return router;
}
