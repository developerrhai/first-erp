import { beforeEach, describe, expect, it, vi } from 'vitest';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

const transportMocks = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  return { createTransport, sendMail, verify };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: transportMocks.createTransport },
}));

import { sendEmail } from '../src/core/email/email-service';

describe('exported sendEmail function', () => {
  const result: SMTPTransport.SentMessageInfo = {
    envelope: { from: 'administration@example.invalid', to: ['client@example.invalid'] },
    messageId: 'message-id',
    accepted: ['client@example.invalid'],
    rejected: [],
    pending: [],
    response: '250 accepted',
    envelopeTime: 1,
    messageTime: 1,
    messageSize: 64,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    transportMocks.sendMail.mockResolvedValue(result);
  });

  it('can be imported and called directly with a department, recipient, subject and body', async () => {
    await expect(
      sendEmail({
        department: 'Administration',
        to: 'client@example.invalid',
        subject: 'Purchase Order Notification',
        body: 'Your Purchase Order has been forwarded.',
      }),
    ).resolves.toEqual(result);

    expect(transportMocks.createTransport).toHaveBeenCalledOnce();
    expect(transportMocks.sendMail).toHaveBeenCalledWith({
      to: 'client@example.invalid',
      cc: undefined,
      bcc: undefined,
      subject: 'Purchase Order Notification',
      text: 'Your Purchase Order has been forwarded.',
      html: undefined,
      attachments: undefined,
      from: 'administration@example.invalid',
    });
  });

  it('keeps SMTP failures sanitized for direct callers', async () => {
    transportMocks.sendMail.mockRejectedValue(
      new Error('smtp-password client@example.invalid private message'),
    );

    await expect(
      sendEmail({
        department: 'Administration',
        to: 'client@example.invalid',
        subject: 'Notice',
        body: 'Private message',
      }),
    ).rejects.toThrow('SMTP email delivery failed.');
  });
});
