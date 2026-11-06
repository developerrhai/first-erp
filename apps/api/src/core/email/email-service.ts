import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { EMAIL_SENDER_CONFIG_KEYS, env, isValidSmtpHost } from '../../config/env';
import type { EmailDepartment } from '../../config/env';
import { logger } from '../logger';

type EmailSenderConfigKey = (typeof EMAIL_SENDER_CONFIG_KEYS)[EmailDepartment];
type SmtpConfiguration = Pick<
  typeof env,
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_SECURE'
  | 'SMTP_AUTH_METHOD'
  | 'SMTP_USER'
  | 'SMTP_PASSWORD'
  | EmailSenderConfigKey
>;

export const emailAddressSchema = z.string().trim().email();
export const emailRecipientSchema = z.union([
  emailAddressSchema,
  z.array(emailAddressSchema).min(1).max(50),
]);
export const emailSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
export const emailAttachmentOptionsSchema = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/\r\n\0]/.test(value)),
    contentType: z
      .string()
      .regex(/^[\w.+-]+\/[\w.+-]+$/)
      .optional(),
    contentDisposition: z.enum(['attachment', 'inline']).optional(),
  })
  .strict();
const attachmentSchema = emailAttachmentOptionsSchema
  .extend({ content: z.union([z.string(), z.instanceof(Buffer)]) })
  .refine(
    ({ content }) =>
      (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength) <=
      10 * 1024 * 1024,
  );
const emailMessageSchema = z
  .object({
    to: emailRecipientSchema,
    cc: emailRecipientSchema.optional(),
    bcc: emailRecipientSchema.optional(),
    subject: emailSubjectSchema,
    text: z.string().max(100_000).optional(),
    html: z.string().max(100_000).optional(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .refine(
    (message) =>
      (typeof message.text === 'string' && message.text.trim().length > 0) ||
      (typeof message.html === 'string' && message.html.trim().length > 0),
  )
  .refine(
    (message) =>
      (message.attachments ?? []).reduce(
        (total, attachment) =>
          total +
          (typeof attachment.content === 'string'
            ? Buffer.byteLength(attachment.content)
            : attachment.content.byteLength),
        0,
      ) <=
      20 * 1024 * 1024,
  );

export type EmailMessage = z.infer<typeof emailMessageSchema>;
export type DepartmentEmailRequest = {
  department: EmailDepartment;
  to: EmailMessage['to'];
  cc?: EmailMessage['cc'];
  bcc?: EmailMessage['bcc'];
  subject: string;
  body: string;
  html?: string;
  attachments?: EmailMessage['attachments'];
};
export type EmailSubmissionResult = SMTPTransport.SentMessageInfo;

export type EmailServiceErrorCategory =
  | 'configuration'
  | 'authentication'
  | 'connection'
  | 'provider_rejection'
  | 'invalid_message'
  | 'authorization';

export class EmailServiceError extends Error {
  constructor(
    readonly category: EmailServiceErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = 'EmailServiceError';
  }
}

export type SmtpConfigurationStatus = 'disabled' | 'incomplete' | 'invalid' | 'ready';
export type SmtpConfigurationDiagnostics = {
  status: SmtpConfigurationStatus;
  issues: string[];
  configuredDepartments: EmailDepartment[];
  authentication: 'none' | 'username_password' | 'incomplete';
  tlsMode: 'implicit_tls' | 'starttls' | 'not_configured';
};

const smtpSettingKeys = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_AUTH_METHOD',
  'SMTP_USER',
  'SMTP_PASSWORD',
] as const;

export function normalizeEmailDepartment(value: string): EmailDepartment | undefined {
  const normalized = value.trim().toLowerCase();
  return (Object.keys(EMAIL_SENDER_CONFIG_KEYS) as EmailDepartment[]).find(
    (department) => department.toLowerCase() === normalized,
  );
}

export function diagnoseSmtpConfiguration(
  config: Partial<Record<EmailSenderConfigKey | (typeof smtpSettingKeys)[number], unknown>>,
): SmtpConfigurationDiagnostics {
  const issues: string[] = [];
  let invalid = false;
  const configuredDepartments = (
    Object.entries(EMAIL_SENDER_CONFIG_KEYS) as [EmailDepartment, EmailSenderConfigKey][]
  )
    .filter(([, key]) => config[key] !== undefined)
    .map(([department, key]) => {
      if (typeof config[key] !== 'string' || !z.string().email().safeParse(config[key]).success) {
        invalid = true;
        issues.push(`${key} is invalid`);
      }
      return department;
    });

  const smtpSettingsPresent = smtpSettingKeys.some((key) => config[key] !== undefined);
  const anySettingPresent = smtpSettingsPresent || configuredDepartments.length > 0;
  if (!anySettingPresent) {
    return {
      status: 'disabled',
      issues: [],
      configuredDepartments: [],
      authentication: 'none',
      tlsMode: 'not_configured',
    };
  }

  if (typeof config.SMTP_HOST !== 'string' || config.SMTP_HOST.trim() === '') {
    issues.push('SMTP_HOST is required');
  } else if (!isValidSmtpHost(config.SMTP_HOST.trim())) {
    invalid = true;
    issues.push('SMTP_HOST must be a hostname without protocol, port, credentials, or path');
  }
  if (
    config.SMTP_PORT !== undefined &&
    (typeof config.SMTP_PORT !== 'number' ||
      !Number.isInteger(config.SMTP_PORT) ||
      config.SMTP_PORT < 1 ||
      config.SMTP_PORT > 65535)
  ) {
    invalid = true;
    issues.push('SMTP_PORT must be an integer from 1 to 65535');
  }
  if (config.SMTP_SECURE !== undefined && typeof config.SMTP_SECURE !== 'boolean') {
    invalid = true;
    issues.push('SMTP_SECURE must be true or false');
  }
  if (configuredDepartments.length === 0) {
    issues.push('At least one department EMAIL_FROM_* sender is required');
  }

  const hasUser = typeof config.SMTP_USER === 'string' && config.SMTP_USER.trim().length > 0;
  const hasPassword = typeof config.SMTP_PASSWORD === 'string' && config.SMTP_PASSWORD.length > 0;
  if (
    (config.SMTP_USER !== undefined && !hasUser) ||
    (config.SMTP_PASSWORD !== undefined && !hasPassword)
  ) {
    invalid = true;
    issues.push('SMTP_USER and SMTP_PASSWORD must not be empty');
  }
  const credentialsComplete = hasUser && hasPassword;
  const method = config.SMTP_AUTH_METHOD;
  const authentication =
    (method === 'password' || (method === undefined && credentialsComplete)) && credentialsComplete
      ? 'username_password'
      : method === 'none' && !hasUser && !hasPassword
        ? 'none'
        : 'incomplete';
  if (method !== undefined && method !== 'password' && method !== 'none') {
    invalid = true;
    issues.push('SMTP_AUTH_METHOD must be password or none');
  }
  if (method === 'none' && (hasUser || hasPassword)) {
    invalid = true;
    issues.push('SMTP_AUTH_METHOD=none cannot be combined with SMTP credentials');
  }
  if (authentication === 'incomplete') {
    issues.push(
      credentialsComplete
        ? 'SMTP_AUTH_METHOD must be password when credentials are configured'
        : 'SMTP_USER and SMTP_PASSWORD must be configured together, or set SMTP_AUTH_METHOD=none for an approved unauthenticated relay',
    );
  }
  if (method === 'password' && !credentialsComplete) {
    issues.push('SMTP_USER and SMTP_PASSWORD must be configured together');
  }

  const hasIncompleteSettings = issues.some(
    (issue) =>
      issue.includes('is required') ||
      issue.includes('At least one department') ||
      issue.includes('must be configured together') ||
      issue.includes('Set SMTP_AUTH_METHOD') ||
      issue.includes('SMTP_AUTH_METHOD must be password'),
  );
  return {
    status: invalid ? 'invalid' : hasIncompleteSettings ? 'incomplete' : 'ready',
    issues,
    configuredDepartments,
    authentication,
    tlsMode:
      typeof config.SMTP_HOST !== 'string'
        ? 'not_configured'
        : config.SMTP_SECURE === true
          ? 'implicit_tls'
          : 'starttls',
  };
}

type MailTransport = Pick<
  Transporter<SMTPTransport.SentMessageInfo, SMTPTransport.Options>,
  'sendMail' | 'verify'
>;
type TransportFactory = (options: SMTPTransport.Options) => MailTransport;
type SendEmail = {
  (request: DepartmentEmailRequest): Promise<EmailSubmissionResult>;
  (department: EmailDepartment, message: EmailMessage): Promise<EmailSubmissionResult>;
};

type SafeSmtpDiagnostics = {
  smtpResponseCode?: number;
  smtpCommand?: string;
  nodemailerErrorCode?: string;
  acceptedRecipientCount?: number;
  rejectedRecipientCount?: number;
  rejectedErrorCount?: number;
  pendingRecipientCount?: number;
  hasPendingRecipients?: boolean;
  allRequestedRecipientsAccepted?: boolean;
  senderMatchesAuthenticatedUser?: boolean;
};

const SAFE_SMTP_COMMANDS = [
  'AUTH',
  'CONN',
  'DATA',
  'EHLO',
  'HELO',
  'MAIL FROM',
  'QUIT',
  'RCPT TO',
  'STARTTLS',
] as const;

function logEmailFailure(
  operation: 'send' | 'verify',
  category: EmailServiceErrorCategory,
  diagnostics: SafeSmtpDiagnostics = {},
): void {
  logger.warn(
    {
      emailOperation: operation,
      emailErrorCategory: category,
      ...diagnostics,
    },
    'Email operation failed',
  );
}

function getSafeSmtpDiagnostics(error: unknown): SafeSmtpDiagnostics {
  if (typeof error !== 'object' || error === null) return {};
  const details = error as {
    code?: unknown;
    command?: unknown;
    responseCode?: unknown;
    accepted?: unknown;
    rejected?: unknown;
    pending?: unknown;
  };
  const diagnostics: SafeSmtpDiagnostics = {};
  if (
    typeof details.responseCode === 'number' &&
    Number.isInteger(details.responseCode) &&
    details.responseCode >= 100 &&
    details.responseCode <= 599
  ) {
    diagnostics.smtpResponseCode = details.responseCode;
  }
  if (typeof details.command === 'string') {
    const command = details.command.trim().toUpperCase();
    diagnostics.smtpCommand = SAFE_SMTP_COMMANDS.find(
      (safeCommand) => command === safeCommand || command.startsWith(`${safeCommand}:`),
    );
  }
  if (typeof details.code === 'string' && /^[A-Z0-9_-]{1,32}$/i.test(details.code)) {
    diagnostics.nodemailerErrorCode = details.code.toUpperCase();
  }
  if (Array.isArray(details.accepted)) {
    diagnostics.acceptedRecipientCount = details.accepted.length;
  }
  if (Array.isArray(details.rejected)) {
    diagnostics.rejectedRecipientCount = details.rejected.length;
  }
  if (Array.isArray(details.pending)) {
    diagnostics.pendingRecipientCount = details.pending.length;
  }
  return diagnostics;
}

function senderMatchesAuthenticatedUser(sender: string, config: SmtpConfiguration): boolean {
  return (
    typeof config.SMTP_USER === 'string' &&
    sender.trim().toLowerCase() === config.SMTP_USER.trim().toLowerCase()
  );
}

function classifyTransportError(
  error: unknown,
): 'authentication' | 'connection' | 'provider_rejection' {
  if (typeof error !== 'object' || error === null) return 'connection';
  const details = error as { code?: unknown; command?: unknown; responseCode?: unknown };
  const code = typeof details.code === 'string' ? details.code.toUpperCase() : '';
  const command = typeof details.command === 'string' ? details.command.toUpperCase() : '';
  const responseCode = typeof details.responseCode === 'number' ? details.responseCode : undefined;

  if (
    command === 'AUTH' ||
    ['EAUTH', 'EAUTHFAILED', 'ELOGIN'].includes(code) ||
    responseCode === 530 ||
    responseCode === 534 ||
    responseCode === 535
  ) {
    return 'authentication';
  }
  if (responseCode !== undefined && responseCode >= 400) return 'provider_rejection';
  return 'connection';
}

function getRecipientAddress(recipient: unknown): string | undefined {
  if (typeof recipient === 'string') return recipient;
  if (typeof recipient !== 'object' || recipient === null || !('address' in recipient)) {
    return undefined;
  }
  return typeof recipient.address === 'string' ? recipient.address : undefined;
}

export function assertEmailSubmissionAccepted(
  result: EmailSubmissionResult,
  recipients?: Pick<EmailMessage, 'to' | 'cc' | 'bcc'>,
  diagnostics: Pick<SafeSmtpDiagnostics, 'senderMatchesAuthenticatedUser'> = {},
): EmailSubmissionResult {
  const acceptedAddresses = new Set(
    (Array.isArray(result?.accepted) ? result.accepted : [])
      .map(getRecipientAddress)
      .filter((address): address is string => typeof address === 'string')
      .map((address) => address.toLowerCase()),
  );
  const requestedAddresses = recipients
    ? [recipients.to, recipients.cc, recipients.bcc]
        .flatMap((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
        .map((address) => address.toLowerCase())
    : [];
  const allRequestedRecipientsAccepted = requestedAddresses.every((address) =>
    acceptedAddresses.has(address),
  );
  // Nodemailer's SMTP transport omits `pending`; that field is only populated by other transports.
  const pendingRecipients = Array.isArray(result?.pending) ? result.pending : [];
  if (
    !Array.isArray(result?.accepted) ||
    !Array.isArray(result.rejected) ||
    result.accepted.length === 0 ||
    result.rejected.length > 0 ||
    pendingRecipients.length > 0 ||
    !allRequestedRecipientsAccepted
  ) {
    const rejectedErrors = Array.isArray(result?.rejectedErrors) ? result.rejectedErrors : [];
    const firstRejectedError = rejectedErrors[0];
    logEmailFailure('send', 'provider_rejection', {
      ...(firstRejectedError ? getSafeSmtpDiagnostics(firstRejectedError) : {}),
      acceptedRecipientCount: Array.isArray(result?.accepted) ? result.accepted.length : undefined,
      rejectedRecipientCount: Array.isArray(result?.rejected) ? result.rejected.length : undefined,
      rejectedErrorCount: rejectedErrors.length,
      pendingRecipientCount: pendingRecipients.length,
      hasPendingRecipients: pendingRecipients.length > 0,
      allRequestedRecipientsAccepted,
      ...diagnostics,
    });
    throw new EmailServiceError('provider_rejection', 'SMTP email delivery failed.');
  }
  return result;
}

export function createEmailService(
  config: SmtpConfiguration,
  transportFactory?: TransportFactory,
): {
  sendEmail: SendEmail;
  sendEmailForAuthenticatedUser(
    user: Pick<User, 'department' | 'status'>,
    message: EmailMessage,
  ): Promise<EmailSubmissionResult>;
  verifySmtpConnection(department: EmailDepartment): Promise<true>;
} {
  let transporter: MailTransport | undefined;
  const createTransport =
    transportFactory ?? ((options: SMTPTransport.Options) => nodemailer.createTransport(options));

  function validateMessage(message: EmailMessage): EmailMessage {
    const result = emailMessageSchema.safeParse(message);
    if (!result.success) {
      throw new EmailServiceError(
        'invalid_message',
        'Invalid email message. Check recipients, subject, content, and attachments.',
      );
    }
    return result.data;
  }

  function getSender(departmentName: string, operation: 'send' | 'verify' = 'send'): string {
    const department = normalizeEmailDepartment(departmentName);
    if (!department) {
      logEmailFailure(operation, 'configuration');
      throw new EmailServiceError(
        'configuration',
        'Email sender is not configured for the requested department.',
      );
    }
    const senderKey = EMAIL_SENDER_CONFIG_KEYS[department];
    const sender = config[senderKey];
    if (!sender || !z.string().email().safeParse(sender).success) {
      logEmailFailure(operation, 'configuration');
      throw new EmailServiceError(
        'configuration',
        `Email sender is not configured for department ${department}.`,
      );
    }
    return sender;
  }

  function getTransporter(operation: 'send' | 'verify' = 'send'): MailTransport {
    const diagnostics = diagnoseSmtpConfiguration(config);
    if (diagnostics.status === 'disabled') {
      logEmailFailure(operation, 'configuration');
      throw new EmailServiceError(
        'configuration',
        'Email service is not configured. Set SMTP_HOST.',
      );
    }
    if (!config.SMTP_HOST && smtpSettingKeys.every((key) => config[key] === undefined)) {
      logEmailFailure(operation, 'configuration');
      throw new EmailServiceError(
        'configuration',
        'Email service is not configured. Set SMTP_HOST.',
      );
    }
    if (diagnostics.status !== 'ready') {
      logEmailFailure(operation, 'configuration');
      throw new EmailServiceError(
        'configuration',
        `Email service configuration ${diagnostics.status}: ${diagnostics.issues.join('; ')}.`,
      );
    }
    if (!transporter) {
      const secure = config.SMTP_SECURE ?? false;
      const options: SMTPTransport.Options = {
        host: config.SMTP_HOST?.trim(),
        port: config.SMTP_PORT ?? (secure ? 465 : 587),
        secure,
        requireTLS: !secure,
        ...(diagnostics.authentication === 'username_password' &&
        config.SMTP_USER &&
        config.SMTP_PASSWORD
          ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
          : {}),
      };
      transporter = createTransport(options);
    }
    return transporter;
  }

  async function sendForDepartment(
    department: EmailDepartment,
    message: EmailMessage,
  ): Promise<EmailSubmissionResult> {
    const from = getSender(department);
    const validatedMessage = validateMessage(message);
    const transport = getTransporter();
    let result: EmailSubmissionResult;
    try {
      result = await transport.sendMail({ ...validatedMessage, from });
    } catch (error) {
      const category = classifyTransportError(error);
      logEmailFailure('send', category, {
        ...getSafeSmtpDiagnostics(error),
        senderMatchesAuthenticatedUser: senderMatchesAuthenticatedUser(from, config),
      });
      throw new EmailServiceError(category, 'SMTP email delivery failed.');
    }
    return assertEmailSubmissionAccepted(result, validatedMessage, {
      senderMatchesAuthenticatedUser: senderMatchesAuthenticatedUser(from, config),
    });
  }

  const sendEmail: SendEmail = async (
    departmentOrRequest: EmailDepartment | DepartmentEmailRequest,
    message?: EmailMessage,
  ) => {
    if (typeof departmentOrRequest !== 'string') {
      return sendForDepartment(departmentOrRequest.department, {
        to: departmentOrRequest.to,
        cc: departmentOrRequest.cc,
        bcc: departmentOrRequest.bcc,
        subject: departmentOrRequest.subject,
        text: departmentOrRequest.body,
        html: departmentOrRequest.html,
        attachments: departmentOrRequest.attachments,
      });
    }
    if (!message) throw new Error('Email message is required.');
    return sendForDepartment(departmentOrRequest, message);
  };

  return {
    sendEmail,
    async sendEmailForAuthenticatedUser(user, message) {
      if (user.status !== 'ACTIVE') {
        throw new EmailServiceError(
          'authorization',
          'Email sending is not available to inactive users.',
        );
      }
      const department = user.department ? normalizeEmailDepartment(user.department) : undefined;
      if (!department) {
        throw new EmailServiceError(
          'configuration',
          'Email sender is not configured for the authenticated user department.',
        );
      }
      return sendForDepartment(department, message);
    },
    async verifySmtpConnection(department) {
      getSender(department, 'verify');
      const transport = getTransporter('verify');
      try {
        return await transport.verify();
      } catch (error) {
        const category = classifyTransportError(error);
        logEmailFailure('verify', category, getSafeSmtpDiagnostics(error));
        throw new EmailServiceError(
          category,
          'SMTP connection verification failed. Check SMTP settings and connectivity.',
        );
      }
    },
  };
}

export const emailService = createEmailService(env);
export function sendEmail(request: DepartmentEmailRequest): Promise<EmailSubmissionResult>;
export function sendEmail(
  department: EmailDepartment,
  message: EmailMessage,
): Promise<EmailSubmissionResult>;
export function sendEmail(
  departmentOrRequest: EmailDepartment | DepartmentEmailRequest,
  message?: EmailMessage,
): Promise<EmailSubmissionResult> {
  if (typeof departmentOrRequest !== 'string') {
    return emailService.sendEmail(departmentOrRequest.department, {
      to: departmentOrRequest.to,
      cc: departmentOrRequest.cc,
      bcc: departmentOrRequest.bcc,
      subject: departmentOrRequest.subject,
      text: departmentOrRequest.body,
      html: departmentOrRequest.html,
      attachments: departmentOrRequest.attachments,
    });
  }
  if (!message) return Promise.reject(new Error('Email message is required.'));
  return emailService.sendEmail(departmentOrRequest, message);
}
export const sendEmailForAuthenticatedUser = (
  user: Pick<User, 'department' | 'status'>,
  message: EmailMessage,
): Promise<EmailSubmissionResult> => emailService.sendEmailForAuthenticatedUser(user, message);
export const verifySmtpConnection = (department: EmailDepartment): Promise<true> =>
  emailService.verifySmtpConnection(department);
