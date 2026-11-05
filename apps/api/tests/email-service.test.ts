import { Writable } from 'node:stream';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_SENDER_CONFIG_KEYS, loadEnv } from '../src/config/env';
import type { EmailDepartment } from '../src/config/env';
import {
  createEmailService,
  diagnoseSmtpConfiguration,
  normalizeEmailDepartment,
} from '../src/core/email/email-service';
import { emailTemplateDrafts } from '../src/core/email/email-templates';
import { EmailServiceError } from '../src/core/email/email-service';
import { createLogger, logger } from '../src/core/logger';
import { EMAIL_TEST_ENV } from './email-setup-env';

const senderAddresses: Record<EmailDepartment, string> = {
  Administration: 'administration@example.invalid',
  Sales: 'sales@example.invalid',
  Purchase: 'purchase@example.invalid',
  Finance: 'finance@example.invalid',
  HR: 'hr@example.invalid',
  Production: 'production@example.invalid',
  Quality: 'quality@example.invalid',
  Maintenance: 'maintenance@example.invalid',
  Warehouse: 'warehouse@example.invalid',
  Projects: 'projects@example.invalid',
  Service: 'service@example.invalid',
};

const senderConfig = Object.fromEntries(
  Object.entries(EMAIL_SENDER_CONFIG_KEYS).map(([department, key]) => [
    key,
    senderAddresses[department as EmailDepartment],
  ]),
);

const smtpConfig = {
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: 587,
  SMTP_SECURE: false,
  SMTP_USER: 'smtp-user',
  SMTP_PASSWORD: 'smtp-password',
  ...senderConfig,
};

describe('SMTP environment configuration', () => {
  it('keeps every department mapped to a distinct sender configuration key', () => {
    const keys = Object.values(EMAIL_SENDER_CONFIG_KEYS);
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
  });

  it('allows SMTP to remain unconfigured', () => {
    const env = loadEnv(EMAIL_TEST_ENV);
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.EMAIL_FROM_ADMINISTRATION).toBeUndefined();
    expect(env.EMAIL_FROM_SERVICE).toBeUndefined();
  });

  it('validates provider-neutral SMTP settings and department sender identities', () => {
    const env = loadEnv({
      ...EMAIL_TEST_ENV,
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_AUTH_METHOD: 'password',
      SMTP_USER: 'smtp-user',
      SMTP_PASSWORD: 'smtp-password',
      EMAIL_FROM_SALES: senderAddresses.Sales,
    });
    expect(env).toMatchObject({
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_AUTH_METHOD: 'password',
      SMTP_USER: 'smtp-user',
      EMAIL_FROM_SALES: senderAddresses.Sales,
    });
  });

  it('requires an explicit unauthenticated-relay choice when SMTP credentials are absent', () => {
    const env = loadEnv({
      ...EMAIL_TEST_ENV,
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_AUTH_METHOD: 'none',
      EMAIL_FROM_SALES: senderAddresses.Sales,
    });
    expect(env.SMTP_AUTH_METHOD).toBe('none');
    expect(() =>
      loadEnv({
        ...EMAIL_TEST_ENV,
        SMTP_HOST: 'smtp.example.invalid',
        EMAIL_FROM_SALES: senderAddresses.Sales,
      }),
    ).toThrow(/SMTP_AUTH_METHOD/);
  });

  it('rejects invalid department sender addresses', () => {
    expect(() =>
      loadEnv({
        ...EMAIL_TEST_ENV,
        SMTP_HOST: 'smtp.example.invalid',
        EMAIL_FROM_SALES: 'not-an-email',
      }),
    ).toThrow(/EMAIL_FROM_SALES/);
  });

  it('requires a department sender and matched SMTP credentials when SMTP is configured', () => {
    expect(() => loadEnv({ ...EMAIL_TEST_ENV, SMTP_HOST: 'smtp.example.invalid' })).toThrow(
      /EMAIL_FROM_.*sender/,
    );
    expect(() =>
      loadEnv({
        ...EMAIL_TEST_ENV,
        SMTP_HOST: 'smtp.example.invalid',
        EMAIL_FROM_SALES: senderAddresses.Sales,
        SMTP_USER: 'smtp-user',
      }),
    ).toThrow(/SMTP_USER and SMTP_PASSWORD/);
    expect(() => loadEnv({ ...EMAIL_TEST_ENV, SMTP_PORT: '70000' })).toThrow(/SMTP_PORT/);
  });

  it('rejects SMTP hosts containing schemes, ports or paths', () => {
    expect(() =>
      loadEnv({
        ...EMAIL_TEST_ENV,
        SMTP_HOST: 'smtp://smtp.example.invalid:587/path',
        EMAIL_FROM_SALES: senderAddresses.Sales,
      }),
    ).toThrow(/SMTP_HOST/);
  });

  it('does not accept the legacy common sender as a department profile', () => {
    expect(() =>
      loadEnv({
        ...EMAIL_TEST_ENV,
        SMTP_HOST: 'smtp.example.invalid',
        EMAIL_FROM: 'common@example.invalid',
      }),
    ).toThrow(/EMAIL_FROM_.*sender/);
  });
});

describe('email service', () => {
  const sentMessageInfo: SMTPTransport.SentMessageInfo = {
    envelope: { from: senderAddresses.Administration, to: ['recipient@example.invalid'] },
    messageId: 'message-id',
    accepted: [
      'recipient@example.invalid',
      'other@example.invalid',
      'to@example.invalid',
      'cc@example.invalid',
      'bcc1@example.invalid',
      'bcc2@example.invalid',
    ],
    rejected: [],
    pending: [],
    response: '250 Message accepted',
    envelopeTime: 1,
    messageTime: 1,
    messageSize: 64,
  };

  it('creates one reusable transport, selects department senders, and passes attachments through', async () => {
    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const verify = vi.fn().mockResolvedValue(true as const);
    const transportFactory = vi.fn(() => ({ sendMail, verify }));
    const service = createEmailService(smtpConfig, transportFactory);
    const attachments = [{ filename: 'report.txt', content: 'report' }];
    const message = {
      to: 'recipient@example.invalid',
      subject: 'Report',
      text: 'Plain text',
      html: '<p>Report</p>',
      attachments,
    };

    await expect(service.sendEmail('Administration', message)).resolves.toEqual(sentMessageInfo);
    await service.sendEmail('Sales', {
      to: 'other@example.invalid',
      subject: 'Second',
      text: 'Text',
    });

    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledWith({
      host: smtpConfig.SMTP_HOST,
      port: smtpConfig.SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { user: smtpConfig.SMTP_USER, pass: smtpConfig.SMTP_PASSWORD },
    });
    expect(sendMail).toHaveBeenNthCalledWith(1, {
      ...message,
      from: senderAddresses.Administration,
    });
    expect(sendMail).toHaveBeenNthCalledWith(2, {
      to: 'other@example.invalid',
      subject: 'Second',
      text: 'Text',
      from: senderAddresses.Sales,
    });
    await expect(service.verifySmtpConnection('Administration')).resolves.toBe(true);
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledOnce();
  });

  it('rejects partial, total, or pending recipient outcomes instead of reporting success', async () => {
    const cases: Array<{
      name: string;
      accepted: string[];
      rejected: string[];
      pending: string[];
    }> = [
      {
        name: 'partial acceptance',
        accepted: ['recipient@example.invalid'],
        rejected: ['second@example.invalid'],
        pending: [],
      },
      {
        name: 'total rejection',
        accepted: [],
        rejected: ['recipient@example.invalid'],
        pending: [],
      },
      {
        name: 'pending recipient',
        accepted: [],
        rejected: [],
        pending: ['recipient@example.invalid'],
      },
    ];

    for (const outcome of cases) {
      const service = createEmailService(smtpConfig, () => ({
        sendMail: vi.fn().mockResolvedValue({
          ...sentMessageInfo,
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          pending: outcome.pending,
        }),
        verify: vi.fn().mockResolvedValue(true as const),
      }));

      await expect(
        service.sendEmail('Administration', {
          to: ['recipient@example.invalid', 'second@example.invalid'],
          subject: 'Notice',
          text: 'Body',
        }),
        outcome.name,
      ).rejects.toMatchObject({
        category: 'provider_rejection',
        message: 'SMTP email delivery failed.',
      });
    }
  });

  it('accepts a Nodemailer SMTP result that omits its optional pending field', async () => {
    const result = {
      ...sentMessageInfo,
      accepted: ['recipient@example.invalid'],
      rejected: [],
    };
    Reflect.deleteProperty(result, 'pending');
    const sendMail = vi.fn().mockResolvedValue(result);
    const service = createEmailService(smtpConfig, () => ({
      sendMail,
      verify: vi.fn().mockResolvedValue(true as const),
    }));

    await expect(
      service.sendEmail('Administration', {
        to: 'recipient@example.invalid',
        subject: 'Notice',
        text: 'Body',
      }),
    ).resolves.toEqual(result);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('categorizes and safely logs authentication and connection failures', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const failures = [
        {
          error: Object.assign(new Error('private smtp password and recipient details'), {
            code: 'EAUTH',
            command: 'AUTH',
            responseCode: 535,
          }),
          category: 'authentication',
        },
        {
          error: Object.assign(new Error('private connection details'), { code: 'ECONNECTION' }),
          category: 'connection',
        },
        {
          error: Object.assign(new Error('private provider response details'), {
            responseCode: 550,
          }),
          category: 'provider_rejection',
        },
      ] as const;

      for (const failure of failures) {
        const service = createEmailService(smtpConfig, () => ({
          sendMail: vi.fn().mockRejectedValue(failure.error),
          verify: vi.fn().mockResolvedValue(true as const),
        }));
        const error = await service
          .sendEmail('Administration', {
            to: 'recipient@example.invalid',
            subject: 'Sensitive subject',
            text: 'Sensitive body',
          })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(EmailServiceError);
        expect(error).toMatchObject({
          category: failure.category,
          message: 'SMTP email delivery failed.',
        });
      }

      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          emailOperation: 'send',
          emailErrorCategory: 'authentication',
          nodemailerErrorCode: 'EAUTH',
          smtpCommand: 'AUTH',
          smtpResponseCode: 535,
          senderMatchesAuthenticatedUser: false,
        }),
        'Email operation failed',
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          emailOperation: 'send',
          emailErrorCategory: 'connection',
          nodemailerErrorCode: 'ECONNECTION',
          senderMatchesAuthenticatedUser: false,
        }),
        'Email operation failed',
      );
      expect(warn).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          emailOperation: 'send',
          emailErrorCategory: 'provider_rejection',
          smtpResponseCode: 550,
          senderMatchesAuthenticatedUser: false,
        }),
        'Email operation failed',
      );

      const configurationService = createEmailService({
        EMAIL_FROM_ADMINISTRATION: senderAddresses.Administration,
      });
      const configurationError = await configurationService
        .sendEmail('Administration', {
          to: 'recipient@example.invalid',
          subject: 'Notice',
          text: 'Body',
        })
        .catch((caught: unknown) => caught);

      expect(configurationError).toBeInstanceOf(EmailServiceError);
      expect(configurationError).toMatchObject({ category: 'configuration' });
      expect(warn).toHaveBeenNthCalledWith(
        4,
        { emailOperation: 'send', emailErrorCategory: 'configuration' },
        'Email operation failed',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('recipient@example.invalid');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs only safe SMTP rejection fields and counts for returned recipient results', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const gmailSender = 'gmail-test-mailbox@gmail.com';
    const service = createEmailService(
      { ...smtpConfig, SMTP_USER: gmailSender, EMAIL_FROM_ADMINISTRATION: gmailSender },
      () => ({
        sendMail: vi.fn().mockResolvedValue({
          ...sentMessageInfo,
          accepted: ['accepted@example.invalid'],
          rejected: ['private-recipient@example.invalid'],
          rejectedErrors: [
            Object.assign(new Error('550 5.1.1 private-recipient@example.invalid rejected'), {
              code: 'EENVELOPE',
              command: 'RCPT TO:<private-recipient@example.invalid>',
              responseCode: 550,
              response: '550 5.1.1 private-recipient@example.invalid rejected',
            }),
          ],
          response: '250 2.0.0 Message accepted',
        }),
        verify: vi.fn().mockResolvedValue(true as const),
      }),
    );

    try {
      await expect(
        service.sendEmail('Administration', {
          to: ['accepted@example.invalid', 'private-recipient@example.invalid'],
          subject: 'Notice',
          text: 'Body',
        }),
      ).rejects.toMatchObject({ category: 'provider_rejection' });

      expect(warn).toHaveBeenCalledWith(
        {
          emailOperation: 'send',
          emailErrorCategory: 'provider_rejection',
          smtpResponseCode: 550,
          smtpCommand: 'RCPT TO',
          nodemailerErrorCode: 'EENVELOPE',
          acceptedRecipientCount: 1,
          rejectedRecipientCount: 1,
          rejectedErrorCount: 1,
          pendingRecipientCount: 0,
          hasPendingRecipients: false,
          allRequestedRecipientsAccepted: false,
          senderMatchesAuthenticatedUser: true,
        },
        'Email operation failed',
      );
      const loggedFields = JSON.stringify(warn.mock.calls);
      expect(loggedFields).not.toContain('private-recipient@example.invalid');
      expect(loggedFields).not.toContain('gmail-test-mailbox@gmail.com');
      expect(loggedFields).not.toContain('5.1.1');
      expect(loggedFields).not.toContain('private');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs only a boolean when an accepted address does not match the requested recipient', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const service = createEmailService(smtpConfig, () => ({
      sendMail: vi.fn().mockResolvedValue({
        ...sentMessageInfo,
        accepted: ['different@example.invalid'],
        rejected: [],
        pending: [],
      }),
      verify: vi.fn().mockResolvedValue(true as const),
    }));

    try {
      await expect(
        service.sendEmail('Administration', {
          to: 'requested@example.invalid',
          subject: 'Notice',
          text: 'Body',
        }),
      ).rejects.toMatchObject({ category: 'provider_rejection' });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          emailErrorCategory: 'provider_rejection',
          acceptedRecipientCount: 1,
          rejectedRecipientCount: 0,
          pendingRecipientCount: 0,
          hasPendingRecipients: false,
          allRequestedRecipientsAccepted: false,
        }),
        'Email operation failed',
      );
      const loggedFields = JSON.stringify(warn.mock.calls);
      expect(loggedFields).not.toContain('different@example.invalid');
      expect(loggedFields).not.toContain('requested@example.invalid');
    } finally {
      warn.mockRestore();
    }
  });

  it('sanitizes SMTP command details while logging Nodemailer rejection codes', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(new Error('550 5.1.1 rejected private-recipient@example.invalid'), {
      code: 'EENVELOPE',
      command: 'RCPT TO:<private-recipient@example.invalid>',
      responseCode: 550,
      response: '550 5.1.1 rejected private-recipient@example.invalid',
      rejected: ['private-recipient@example.invalid'],
    });
    const service = createEmailService(smtpConfig, () => ({
      sendMail: vi.fn().mockRejectedValue(error),
      verify: vi.fn().mockResolvedValue(true as const),
    }));

    try {
      await expect(
        service.sendEmail('Administration', {
          to: 'private-recipient@example.invalid',
          subject: 'Notice',
          text: 'Body',
        }),
      ).rejects.toMatchObject({ category: 'provider_rejection' });

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          emailOperation: 'send',
          emailErrorCategory: 'provider_rejection',
          smtpResponseCode: 550,
          smtpCommand: 'RCPT TO',
          nodemailerErrorCode: 'EENVELOPE',
          rejectedRecipientCount: 1,
          senderMatchesAuthenticatedUser: false,
        }),
        'Email operation failed',
      );
      const loggedFields = JSON.stringify(warn.mock.calls);
      expect(loggedFields).not.toContain('private-recipient@example.invalid');
      expect(loggedFields).not.toContain('5.1.1');
      expect(loggedFields).not.toContain('private');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(Object.keys(EMAIL_SENDER_CONFIG_KEYS) as EmailDepartment[])(
    'uses the configured %s sender profile',
    async (department) => {
      const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
      const transportFactory = vi.fn(() => ({
        sendMail,
        verify: vi.fn().mockResolvedValue(true as const),
      }));
      const service = createEmailService(smtpConfig, transportFactory);

      await service.sendEmail(department, {
        to: 'recipient@example.invalid',
        subject: 'Department test',
        text: 'Test',
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: senderAddresses[department] }),
      );
    },
  );

  it('normalizes known department identifiers without accepting unknown aliases', async () => {
    expect(normalizeEmailDepartment('  sAlEs ')).toBe('Sales');
    expect(normalizeEmailDepartment('Procurement')).toBeUndefined();

    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const service = createEmailService(smtpConfig, () => ({
      sendMail,
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    await service.sendEmailForAuthenticatedUser(
      { department: '  sAlEs ', status: 'ACTIVE' },
      { to: 'recipient@example.invalid', subject: 'Notice', text: 'Body' },
    );
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: senderAddresses.Sales }));
  });

  it('ignores a caller-supplied From and never uses another department sender', async () => {
    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const transportFactory = vi.fn(() => ({
      sendMail,
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService(smtpConfig, transportFactory);
    const messageWithUntrustedFrom = {
      to: 'recipient@example.invalid',
      subject: 'Sales notice',
      text: 'Text',
      from: senderAddresses.Finance,
    };

    await service.sendEmailForAuthenticatedUser(
      { department: 'Sales', status: 'ACTIVE' },
      messageWithUntrustedFrom,
    );

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: senderAddresses.Sales }));
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty('from', senderAddresses.Finance);
  });

  it('supports validated To, CC, BCC and safe in-memory attachments', async () => {
    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const transportFactory = vi.fn(() => ({
      sendMail,
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService(smtpConfig, transportFactory);
    const message = {
      to: ['to@example.invalid'],
      cc: 'cc@example.invalid',
      bcc: ['bcc1@example.invalid', 'bcc2@example.invalid'],
      subject: 'Report',
      text: 'See attached.',
      attachments: [{ filename: 'report.pdf', content: Buffer.from('safe test data') }],
    };

    await service.sendEmail('Sales', message);

    expect(sendMail).toHaveBeenCalledWith({
      ...message,
      from: senderAddresses.Sales,
    });
  });

  it.each([
    {
      name: 'invalid To address',
      message: { to: 'not-an-email', subject: 'Notice', text: 'Body' },
    },
    {
      name: 'invalid CC address',
      message: {
        to: 'to@example.invalid',
        cc: ['valid@example.invalid', 'not-an-email'],
        subject: 'Notice',
        text: 'Body',
      },
    },
    {
      name: 'empty subject',
      message: { to: 'to@example.invalid', subject: ' ', text: 'Body' },
    },
    {
      name: 'missing text and HTML',
      message: { to: 'to@example.invalid', subject: 'Notice' },
    },
    {
      name: 'unsafe path attachment',
      message: {
        to: 'to@example.invalid',
        subject: 'Notice',
        text: 'Body',
        attachments: [{ filename: 'secret.txt', path: 'C:\\private\\secret.txt' }],
      },
    },
  ])('rejects $name before opening a transport', async ({ message }) => {
    const transportFactory = vi.fn();
    const service = createEmailService(smtpConfig, transportFactory);

    await expect(service.sendEmail('Sales', message as never)).rejects.toThrow(
      'Invalid email message. Check recipients, subject, content, and attachments.',
    );
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('rejects manual sends for inactive users or users without a configured department', async () => {
    const transportFactory = vi.fn();
    const service = createEmailService(smtpConfig, transportFactory);
    const message = {
      to: 'recipient@example.invalid',
      subject: 'Notice',
      text: 'Body',
    };

    await expect(
      service.sendEmailForAuthenticatedUser({ department: 'Sales', status: 'INACTIVE' }, message),
    ).rejects.toThrow('Email sending is not available to inactive users.');
    await expect(
      service.sendEmailForAuthenticatedUser({ department: 'Unknown', status: 'ACTIVE' }, message),
    ).rejects.toThrow('Email sender is not configured for the authenticated user department.');
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('defaults to port 465 for implicit TLS and supports unauthenticated relays', async () => {
    const transportFactory = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue(sentMessageInfo),
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService(
      {
        SMTP_HOST: smtpConfig.SMTP_HOST,
        SMTP_SECURE: true,
        SMTP_AUTH_METHOD: 'none',
        EMAIL_FROM_ADMINISTRATION: senderAddresses.Administration,
      },
      transportFactory,
    );

    await service.sendEmail('Administration', {
      to: 'recipient@example.invalid',
      subject: 'Hi',
      html: '<p>Hi</p>',
    });

    expect(transportFactory).toHaveBeenCalledWith({
      host: smtpConfig.SMTP_HOST,
      port: 465,
      secure: true,
      requireTLS: false,
    });
  });

  it('reports SMTP readiness without sending mail or exposing configuration values', () => {
    expect(diagnoseSmtpConfiguration({}).status).toBe('disabled');
    expect(diagnoseSmtpConfiguration({ SMTP_USER: 'secret-user' })).toMatchObject({
      status: 'incomplete',
      authentication: 'incomplete',
    });
    expect(
      diagnoseSmtpConfiguration({
        SMTP_HOST: 'smtp://smtp.example.invalid:587/path',
        SMTP_PORT: 70000,
        SMTP_USER: 'secret-user',
        SMTP_PASSWORD: 'secret-password',
        EMAIL_FROM_SALES: senderAddresses.Sales,
      }),
    ).toMatchObject({
      status: 'invalid',
      configuredDepartments: ['Sales'],
      authentication: 'username_password',
      tlsMode: 'starttls',
    });
    const readyDiagnostics = diagnoseSmtpConfiguration(smtpConfig);
    expect(readyDiagnostics).toMatchObject({
      status: 'ready',
      authentication: 'username_password',
    });
    expect(readyDiagnostics.configuredDepartments).toContain('Purchase');
    expect(readyDiagnostics.configuredDepartments).toContain('Finance');
    const diagnostics = JSON.stringify(diagnoseSmtpConfiguration(smtpConfig));
    expect(diagnostics).not.toContain('smtp-password');
    expect(diagnostics).not.toContain('smtp-user');
  });

  it('blocks an incomplete SMTP authentication configuration before creating a transport', async () => {
    const transportFactory = vi.fn();
    const service = createEmailService(
      {
        SMTP_HOST: 'smtp.example.invalid',
        SMTP_USER: 'smtp-user',
        EMAIL_FROM_SALES: senderAddresses.Sales,
      },
      transportFactory,
    );

    await expect(
      service.sendEmail('Sales', {
        to: 'recipient@example.invalid',
        subject: 'Notice',
        text: 'Body',
      }),
    ).rejects.toThrow('SMTP_USER and SMTP_PASSWORD must be configured together');
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('defaults to port 587 with required STARTTLS when secure mode is false', async () => {
    const transportFactory = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue(sentMessageInfo),
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService(
      {
        SMTP_HOST: smtpConfig.SMTP_HOST,
        SMTP_SECURE: false,
        SMTP_AUTH_METHOD: 'none',
        EMAIL_FROM_ADMINISTRATION: senderAddresses.Administration,
      },
      transportFactory,
    );

    await service.verifySmtpConnection('Administration');

    expect(transportFactory).toHaveBeenCalledWith({
      host: smtpConfig.SMTP_HOST,
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it('supports an isolated Gmail STARTTLS profile with a mocked transport', async () => {
    const gmailSender = 'gmail-test-mailbox@gmail.com';
    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const verify = vi.fn().mockResolvedValue(true as const);
    const transportFactory = vi.fn(() => ({ sendMail, verify }));
    const gmailConfig = {
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_AUTH_METHOD: 'password',
      SMTP_USER: gmailSender,
      SMTP_PASSWORD: 'mock-gmail-app-password',
      EMAIL_FROM_ADMINISTRATION: gmailSender,
    };
    const service = createEmailService(gmailConfig, transportFactory);

    expect(diagnoseSmtpConfiguration(gmailConfig)).toMatchObject({
      status: 'ready',
      configuredDepartments: ['Administration'],
      authentication: 'username_password',
      tlsMode: 'starttls',
    });
    await service.sendEmail('Administration', {
      to: 'recipient@example.invalid',
      subject: 'Mock Gmail profile test',
      text: 'This message is handled by a mocked transport.',
    });
    await expect(service.verifySmtpConnection('Administration')).resolves.toBe(true);

    expect(transportFactory).toHaveBeenCalledOnce();
    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: gmailSender, pass: 'mock-gmail-app-password' },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: gmailSender, to: 'recipient@example.invalid' }),
    );
    expect(verify).toHaveBeenCalledOnce();
  });

  it('respects an explicitly configured SMTP port', async () => {
    const transportFactory = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue(sentMessageInfo),
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService({ ...smtpConfig, SMTP_PORT: 2525 }, transportFactory);

    await service.verifySmtpConnection('Administration');

    expect(transportFactory).toHaveBeenCalledWith({
      host: smtpConfig.SMTP_HOST,
      port: 2525,
      secure: false,
      requireTLS: true,
      auth: { user: smtpConfig.SMTP_USER, pass: smtpConfig.SMTP_PASSWORD },
    });
  });

  it('verifies SMTP connectivity without sending a message', async () => {
    const sendMail = vi.fn().mockResolvedValue(sentMessageInfo);
    const verify = vi.fn().mockResolvedValue(true as const);
    const transportFactory = vi.fn(() => ({ sendMail, verify }));
    const service = createEmailService(smtpConfig, transportFactory);

    await expect(service.verifySmtpConnection('Sales')).resolves.toBe(true);

    expect(verify).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reuses the transport and hides SMTP details when verification fails', async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(new Error('Authentication failed for smtp-user using smtp-password'));
    const transportFactory = vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue(sentMessageInfo),
      verify,
    }));
    const service = createEmailService(smtpConfig, transportFactory);

    await expect(service.verifySmtpConnection('Administration')).rejects.toThrow(
      'SMTP connection verification failed. Check SMTP settings and connectivity.',
    );
    expect(transportFactory).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it('fails clearly when a department sender profile is missing or invalid', async () => {
    const transportFactory = vi.fn();
    const missingSenderService = createEmailService(
      { SMTP_HOST: smtpConfig.SMTP_HOST },
      transportFactory,
    );
    const invalidSenderService = createEmailService(
      {
        SMTP_HOST: smtpConfig.SMTP_HOST,
        EMAIL_FROM_FINANCE: 'not-an-email',
      },
      transportFactory,
    );

    await expect(
      missingSenderService.sendEmail('Sales', {
        to: 'recipient@example.invalid',
        subject: 'Hi',
        text: 'Hello',
      }),
    ).rejects.toThrow('Email sender is not configured for department Sales.');
    await expect(invalidSenderService.verifySmtpConnection('Finance')).rejects.toThrow(
      'Email sender is not configured for department Finance.',
    );
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('does not fall back to a common sender', async () => {
    const legacyConfig = {
      SMTP_HOST: smtpConfig.SMTP_HOST,
      EMAIL_FROM: 'common@example.invalid',
    };
    const transportFactory = vi.fn();
    const service = createEmailService(legacyConfig, transportFactory);

    await expect(
      service.sendEmail('Purchase', {
        to: 'recipient@example.invalid',
        subject: 'Hi',
        text: 'Hello',
      }),
    ).rejects.toThrow('Email sender is not configured for department Purchase.');
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('fails clearly when SMTP is not configured', async () => {
    const transportFactory = vi.fn();
    const service = createEmailService(
      { EMAIL_FROM_ADMINISTRATION: senderAddresses.Administration },
      transportFactory,
    );

    await expect(
      service.sendEmail('Administration', {
        to: 'recipient@example.invalid',
        subject: 'Hi',
        text: 'Hello',
      }),
    ).rejects.toThrow('Email service is not configured. Set SMTP_HOST.');
    await expect(service.verifySmtpConnection('Administration')).rejects.toThrow(
      'Email service is not configured. Set SMTP_HOST.',
    );
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('sanitizes SMTP delivery errors without exposing credentials or message content', async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValue(
        new Error('Rejected smtp-password for recipient@example.invalid: Sensitive body'),
      );
    const transportFactory = vi.fn(() => ({
      sendMail,
      verify: vi.fn().mockResolvedValue(true as const),
    }));
    const service = createEmailService(smtpConfig, transportFactory);

    await expect(
      service.sendEmail('Finance', {
        to: 'recipient@example.invalid',
        subject: 'Sensitive subject',
        text: 'Sensitive body',
      }),
    ).rejects.toThrow('SMTP email delivery failed.');
  });

  it('redacts SMTP credentials from Pino logs', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = createLogger('info', sink);
    log.info(
      {
        SMTP_PASSWORD: 'password-secret',
        smtpUser: 'user-secret',
        auth: { pass: 'nested-password', user: 'nested-user' },
        SMTP_CLIENT_SECRET: 'client-secret',
        accessToken: 'access-token',
      },
      'SMTP configuration probe',
    );

    const output = lines.join('');
    for (const secret of [
      'password-secret',
      'user-secret',
      'nested-password',
      'nested-user',
      'client-secret',
      'access-token',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('keeps unfinished business templates explicitly marked as requiring client copy', () => {
    expect(
      Object.values(emailTemplateDrafts).every((draft) => draft.status === 'pending_client_copy'),
    ).toBe(true);
    expect(emailTemplateDrafts.purchaseNotification.subject).toContain('CLIENT-APPROVED');
    expect(emailTemplateDrafts.financeNotification.text).toContain('CLIENT-APPROVED');
  });
});
