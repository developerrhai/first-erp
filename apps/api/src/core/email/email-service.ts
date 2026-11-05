import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { EMAIL_SENDER_CONFIG_KEYS, env, isValidSmtpHost } from '../../config/env';
import type { EmailDepartment } from '../../config/env';

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
      throw new Error(
        'Invalid email message. Check recipients, subject, content, and attachments.',
      );
    }
    return result.data;
  }

  function getSender(departmentName: string): string {
    const department = normalizeEmailDepartment(departmentName);
    if (!department) {
      throw new Error('Email sender is not configured for the requested department.');
    }
    const senderKey = EMAIL_SENDER_CONFIG_KEYS[department];
    const sender = config[senderKey];
    if (!sender || !z.string().email().safeParse(sender).success) {
      throw new Error(`Email sender is not configured for department ${department}.`);
    }
    return sender;
  }

  function getTransporter(): MailTransport {
    const diagnostics = diagnoseSmtpConfiguration(config);
    if (diagnostics.status === 'disabled') {
      throw new Error('Email service is not configured. Set SMTP_HOST.');
    }
    if (!config.SMTP_HOST && smtpSettingKeys.every((key) => config[key] === undefined)) {
      throw new Error('Email service is not configured. Set SMTP_HOST.');
    }
    if (diagnostics.status !== 'ready') {
      throw new Error(
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
    try {
      return await transport.sendMail({ ...validatedMessage, from });
    } catch {
      throw new Error('SMTP email delivery failed.');
    }
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
        throw new Error('Email sending is not available to inactive users.');
      }
      const department = user.department ? normalizeEmailDepartment(user.department) : undefined;
      if (!department) {
        throw new Error('Email sender is not configured for the authenticated user department.');
      }
      return sendForDepartment(department, message);
    },
    async verifySmtpConnection(department) {
      getSender(department);
      const transport = getTransporter();
      try {
        return await transport.verify();
      } catch {
        throw new Error(
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
