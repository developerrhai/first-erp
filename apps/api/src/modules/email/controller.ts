import type { Request, Response } from 'express';
import {
  assertEmailSubmissionAccepted,
  sendEmailForAuthenticatedUser,
} from '../../core/email/email-service';
import { requireAuth } from '../../core/auth/auth-context';
import { AppError, Errors } from '../../core/http/errors';
import { validated } from '../../core/http/validate';
import { emailSendBodySchema } from './schemas';

type SendEmail = typeof sendEmailForAuthenticatedUser;

function mapEmailError(error: unknown): AppError {
  if (!(error instanceof Error)) {
    return new AppError(503, 'INTERNAL', 'Email could not be sent. Please try again later.');
  }
  if (error.message === 'SMTP email delivery failed.') {
    return new AppError(503, 'INTERNAL', 'Email could not be sent. Please try again later.');
  }
  if (
    error.message === 'Email service is not configured. Set SMTP_HOST.' ||
    error.message.startsWith('Email sender is not configured for department ') ||
    error.message === 'Email sender is not configured for the authenticated user department.'
  ) {
    return new AppError(503, 'INTERNAL', 'Email sending is not configured for your department.');
  }
  if (error.message === 'Email sending is not available to inactive users.') {
    return Errors.forbidden();
  }
  if (error.message.startsWith('Invalid email message.')) {
    return Errors.badRequest('The email request is invalid.');
  }
  return new AppError(503, 'INTERNAL', 'Email could not be sent. Please try again later.');
}

export const emailController = {
  send:
    (send: SendEmail = sendEmailForAuthenticatedUser) =>
    async (req: Request, res: Response): Promise<void> => {
      const message = validated(res, 'body', emailSendBodySchema);
      try {
        const result = await send(requireAuth(req).user, message);
        assertEmailSubmissionAccepted(result, message);
      } catch (error) {
        throw mapEmailError(error);
      }

      res
        .status(202)
        .set('Cache-Control', 'no-store')
        .json({ data: { status: 'accepted_by_smtp' } });
    },
};
