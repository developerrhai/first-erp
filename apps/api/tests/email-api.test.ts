import express from 'express';
import type { RequestHandler } from 'express';
import type { User } from '@prisma/client';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { AuthContext } from '../src/core/auth/auth-context';
import { AppError } from '../src/core/http/errors';
import { errorHandler } from '../src/core/http/error-middleware';
import { EMAIL_SEND_PERMISSION } from '../src/core/rbac/permission-model';
import { createRequireEmailSend } from '../src/core/rbac/email-send';
import { validateRows } from '../src/modules/permissions/service';
import { createEmailRouter } from '../src/modules/email/routes';
import type { EmailSendPermissionLookup } from '../src/core/rbac/email-send';
import type { sendEmailForAuthenticatedUser } from '../src/core/email/email-service';

const user: User = {
  id: '497f8f3a-3f9c-4bd0-8d3e-31cf6f75a721',
  loginId: 'email-user',
  email: 'user@example.invalid',
  name: 'Email User',
  role: 'ADMIN',
  department: 'Sales',
  status: 'ACTIVE',
  passwordHash: 'test-hash',
  mustChangePassword: false,
  failedLoginCount: 0,
  lockedUntil: null,
  lastLoginAt: null,
  createdById: null,
  defaultUnitId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  version: 1,
};

const auth: AuthContext = {
  userId: user.id,
  sessionId: 'ec82b668-7e7c-4f4f-91f7-0914086ba0ae',
  role: user.role,
  user,
};

const smtpResult: SMTPTransport.SentMessageInfo = {
  envelope: { from: 'sales@example.invalid', to: ['recipient@example.invalid'] },
  messageId: 'test-message-id',
  accepted: ['recipient@example.invalid', 'copy@example.invalid', 'private@example.invalid'],
  rejected: [],
  pending: [],
  response: '250 accepted',
  envelopeTime: 1,
  messageTime: 1,
  messageSize: 64,
};

const authenticate: RequestHandler = (req, _res, next) => {
  req.auth = auth;
  next();
};

function testApp(
  options: {
    authenticated?: boolean;
    permissionLookup?: EmailSendPermissionLookup;
    sendEmail?: typeof sendEmailForAuthenticatedUser;
  } = {},
) {
  const app = express();
  const testAuthenticate: RequestHandler =
    options.authenticated === false ? (_req, _res, next) => next() : authenticate;
  app.use(
    '/api/v1/email',
    createEmailRouter({
      authenticate: testAuthenticate,
      permissionLookup: options.permissionLookup ?? (() => Promise.resolve(true)),
      sendEmail: options.sendEmail,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('POST /api/v1/email/send', () => {
  let sendEmail: ReturnType<typeof vi.fn<typeof sendEmailForAuthenticatedUser>>;

  beforeEach(() => {
    sendEmail = vi.fn<typeof sendEmailForAuthenticatedUser>().mockResolvedValue(smtpResult);
  });

  it('sends an authenticated user email with CC, BCC and a validated attachment', async () => {
    const app = testApp({ sendEmail });
    const payload = {
      to: ['recipient@example.invalid'],
      cc: 'copy@example.invalid',
      bcc: ['private@example.invalid'],
      subject: 'Report',
      text: 'Plain text',
      html: '<p>Report</p>',
      attachments: [
        {
          filename: 'report.pdf',
          contentType: 'application/pdf',
          contentBase64: Buffer.from('%PDF-1.7').toString('base64'),
        },
      ],
    };

    const response = await request(app).post('/api/v1/email/send').send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ data: { status: 'accepted_by_smtp' } });
    expect(sendEmail).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        attachments: [
          expect.objectContaining({
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('%PDF-1.7'),
          }),
        ],
      }),
    );
  });

  it('returns the existing safe failure response when SMTP partially rejects recipients', async () => {
    sendEmail.mockResolvedValue({
      ...smtpResult,
      accepted: ['recipient@example.invalid'],
      rejected: ['copy@example.invalid'],
    });

    const response = await request(testApp({ sendEmail })).post('/api/v1/email/send').send({
      to: 'recipient@example.invalid',
      cc: 'copy@example.invalid',
      subject: 'Subject',
      text: 'Body',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { message: 'Email could not be sent. Please try again later.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('recipient@example.invalid');
    expect(JSON.stringify(response.body)).not.toContain('copy@example.invalid');
  });

  it('does not report success when SMTP rejects every recipient', async () => {
    sendEmail.mockResolvedValue({
      ...smtpResult,
      accepted: [],
      rejected: ['recipient@example.invalid'],
    });

    const response = await request(testApp({ sendEmail })).post('/api/v1/email/send').send({
      to: 'recipient@example.invalid',
      subject: 'Subject',
      text: 'Body',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { message: 'Email could not be sent. Please try again later.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('recipient@example.invalid');
  });

  it('does not report success when SMTP leaves a recipient pending', async () => {
    sendEmail.mockResolvedValue({
      ...smtpResult,
      accepted: [],
      pending: ['recipient@example.invalid'],
    });

    const response = await request(testApp({ sendEmail })).post('/api/v1/email/send').send({
      to: 'recipient@example.invalid',
      subject: 'Subject',
      text: 'Body',
    });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { message: 'Email could not be sent. Please try again later.' },
    });
  });

  it('rejects invalid recipients and missing subject or message content', async () => {
    const app = testApp({ sendEmail });
    const invalidPayloads = [
      { to: 'invalid-address', subject: 'Subject', text: 'Body' },
      { to: 'recipient@example.invalid', text: 'Body' },
      { to: 'recipient@example.invalid', subject: 'Subject' },
    ];

    for (const payload of invalidPayloads) {
      const response = await request(app).post('/api/v1/email/send').send(payload);
      expect(response.status).toBe(422);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not accept sender addresses or department identity from the request', async () => {
    const app = testApp({ sendEmail });

    const response = await request(app).post('/api/v1/email/send').send({
      to: 'recipient@example.invalid',
      subject: 'Subject',
      text: 'Body',
      from: 'finance@example.invalid',
      department: 'Finance',
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: {
        fields: {
          from: 'Unknown field.',
          department: 'Unknown field.',
        },
      },
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects unsafe attachment fields and invalid base64', async () => {
    const app = testApp({ sendEmail });
    const payload = {
      to: 'recipient@example.invalid',
      subject: 'Subject',
      text: 'Body',
      attachments: [{ filename: '..\\secret.pdf', path: 'C:\\private\\secret.pdf' }],
    };
    const pathResponse = await request(app).post('/api/v1/email/send').send(payload);
    const base64Response = await request(app)
      .post('/api/v1/email/send')
      .send({
        to: 'recipient@example.invalid',
        subject: 'Subject',
        text: 'Body',
        attachments: [{ filename: 'file.pdf', contentBase64: 'not-base64' }],
      });

    expect(pathResponse.status).toBe(422);
    expect(base64Response.status).toBe(422);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns a safe unavailable response when the department sender is missing', async () => {
    sendEmail.mockRejectedValue(new Error('Email sender is not configured for department Sales.'));
    const response = await request(testApp({ sendEmail }))
      .post('/api/v1/email/send')
      .send({ to: 'recipient@example.invalid', subject: 'Subject', text: 'Body' });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: { message: 'Email sending is not configured for your department.' },
    });
    expect(JSON.stringify(response.body)).not.toContain('Sales');
  });

  it('returns a safe SMTP failure response without exposing raw transport errors', async () => {
    sendEmail.mockRejectedValue(
      new Error('SMTP email delivery failed. smtp-password Sensitive email body'),
    );
    const response = await request(testApp({ sendEmail }))
      .post('/api/v1/email/send')
      .send({ to: 'recipient@example.invalid', subject: 'Subject', text: 'Body' });

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('smtp-password');
    expect(JSON.stringify(response.body)).not.toContain('Sensitive email body');
  });

  it('rejects unauthenticated and unauthorized callers before sending', async () => {
    const deniedLookup = vi.fn(() => Promise.resolve(false));
    const unauthorized = await request(testApp({ sendEmail, permissionLookup: deniedLookup }))
      .post('/api/v1/email/send')
      .send({ to: 'recipient@example.invalid', subject: 'Subject', text: 'Body' });
    const unauthenticated = await request(testApp({ sendEmail, authenticated: false }))
      .post('/api/v1/email/send')
      .send({ to: 'recipient@example.invalid', subject: 'Subject', text: 'Body' });

    expect(unauthorized.status).toBe(403);
    expect(unauthenticated.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(deniedLookup).toHaveBeenCalledWith('ADMIN');
  });
});

describe('email.send RBAC permission', () => {
  it('requires an explicit dedicated row and does not inherit role defaults', async () => {
    const lookup = vi.fn(() => Promise.resolve(false));
    const app = express();
    app.use(
      '/send',
      (req, _res, next) => {
        req.auth = auth;
        next();
      },
      createRequireEmailSend(lookup),
      (_req, res) => res.status(204).end(),
    );
    app.use(errorHandler);

    const response = await request(app).post('/send');

    expect(response.status).toBe(403);
    expect(lookup).toHaveBeenCalledWith('ADMIN');
  });

  it('accepts explicit email.send assignment through the existing role-permissions model', () => {
    expect(() =>
      validateRows('MEMBER', [
        {
          resource: '*',
          view: true,
          add: true,
          edit: true,
          delete: false,
          approve: false,
          export: false,
          controls: false,
          scope: 'OWN',
        },
        {
          resource: EMAIL_SEND_PERMISSION,
          view: false,
          add: true,
          edit: false,
          delete: false,
          approve: false,
          export: false,
          controls: false,
          scope: null,
        },
      ]),
    ).not.toThrow();
  });

  it('rejects use of unrelated permissions on the email.send resource', () => {
    try {
      validateRows('MEMBER', [
        {
          resource: '*',
          view: true,
          add: true,
          edit: true,
          delete: false,
          approve: false,
          export: false,
          controls: false,
          scope: 'OWN',
        },
        {
          resource: EMAIL_SEND_PERMISSION,
          view: true,
          add: true,
          edit: false,
          delete: false,
          approve: false,
          export: false,
          controls: false,
          scope: null,
        },
      ]);
      expect.fail('Expected invalid email.send permission row to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (error instanceof AppError) {
        expect(error.fields).toHaveProperty(
          'rows.1.view',
          'The email.send resource only supports add.',
        );
      }
    }
  });
});
