import { z } from 'zod';
import {
  emailAttachmentOptionsSchema,
  emailRecipientSchema,
  emailSubjectSchema,
} from '../../core/email/email-service';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const attachmentUploadSchema = emailAttachmentOptionsSchema.extend({
  contentBase64: z
    .string()
    .min(4)
    .max(MAX_BASE64_LENGTH)
    .regex(BASE64)
    .refine((content) => Buffer.from(content, 'base64').toString('base64') === content),
});

export const emailSendBodySchema = z
  .object({
    to: emailRecipientSchema,
    cc: emailRecipientSchema.optional(),
    bcc: emailRecipientSchema.optional(),
    subject: emailSubjectSchema,
    text: z.string().max(100_000).optional(),
    html: z.string().max(100_000).optional(),
    attachments: z.array(attachmentUploadSchema).max(10).optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (
      !(typeof message.text === 'string' && message.text.trim().length > 0) &&
      !(typeof message.html === 'string' && message.html.trim().length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Provide non-empty text or HTML content.',
      });
    }

    let totalBytes = 0;
    for (const [index, attachment] of (message.attachments ?? []).entries()) {
      const size = Buffer.from(attachment.contentBase64, 'base64').byteLength;
      if (size > MAX_ATTACHMENT_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attachments', index, 'contentBase64'],
          message: 'Each attachment must be 10 MiB or smaller.',
        });
      }
      totalBytes += size;
    }
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachments'],
        message: 'Combined attachments must be 20 MiB or smaller.',
      });
    }
  })
  .transform(({ attachments, ...message }) => ({
    ...message,
    ...(attachments
      ? {
          attachments: attachments.map(({ contentBase64, ...options }) => ({
            ...options,
            content: Buffer.from(contentBase64, 'base64'),
          })),
        }
      : {}),
  }));

export type EmailSendRequest = z.output<typeof emailSendBodySchema>;
