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
import { runEmailTest } from '../scripts/email-test';
import { runEmailVerify } from '../scripts/email-verify';

describe('exported sendEmail function', () => {
  const result: SMTPTransport.SentMessageInfo = {
    envelope: { from: 'administration@example.invalid', to: ['client@example.invalid'] },
    messageId: 'message-id',
    accepted: ['client@example.invalid', 'copy@example.invalid'],
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

  it('supports the exported department-first overload and selects its department sender', async () => {
    const message = {
      to: ['client@example.invalid'],
      cc: 'copy@example.invalid',
      subject: 'Department-first notice',
      text: 'Message body',
    };

    await expect(sendEmail('Administration', message)).resolves.toEqual(result);

    expect(transportMocks.sendMail).toHaveBeenCalledWith({
      ...message,
      bcc: undefined,
      html: undefined,
      attachments: undefined,
      from: 'administration@example.invalid',
    });
  });

  it('propagates sanitized failures through the exported department-first overload', async () => {
    transportMocks.sendMail.mockRejectedValue(
      new Error('private smtp credential client@example.invalid private body'),
    );

    await expect(
      sendEmail('Administration', {
        to: 'client@example.invalid',
        subject: 'Notice',
        text: 'Private body',
      }),
    ).rejects.toThrow('SMTP email delivery failed.');
  });

  it('requires an explicitly provided valid recipient before the email test can send', async () => {
    const send = vi.fn<typeof sendEmail>();

    await expect(runEmailTest([], send)).resolves.toBe(2);
    await expect(runEmailTest(['invalid-recipient'], send)).resolves.toBe(2);
    await expect(
      runEmailTest(['first@example.invalid', 'second@example.invalid'], send),
    ).resolves.toBe(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the explicitly requested test recipient through the central function', async () => {
    const send = vi.fn<typeof sendEmail>().mockResolvedValue(result);

    await expect(runEmailTest(['recipient@example.invalid'], send)).resolves.toBe(0);

    expect(send).toHaveBeenCalledWith('Administration', {
      to: 'recipient@example.invalid',
      subject: 'ERP Email Service test',
      text: 'This is a test message from the ERP Email Service.',
    });
  });

  it('verifies SMTP without invoking email sending', async () => {
    const verify = vi.fn().mockResolvedValue(true as const);

    await expect(runEmailVerify(verify)).resolves.toBe(0);

    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith('Administration');
    expect(transportMocks.sendMail).not.toHaveBeenCalled();
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
