import { emailAddressSchema, EmailServiceError, sendEmail } from '../src/core/email/email-service';

export async function runEmailTest(
  args: readonly string[],
  send: typeof sendEmail = sendEmail,
): Promise<number> {
  if (args.length !== 1 || !emailAddressSchema.safeParse(args[0]).success) {
    process.stderr.write('Usage: npm run email:test -- <recipient-email>\n');
    return 2;
  }

  try {
    await send('Administration', {
      to: args[0],
      subject: 'ERP Email Service test',
      text: 'This is a test message from the ERP Email Service.',
    });
    process.stdout.write('SMTP accepted the test message.\n');
    return 0;
  } catch (error) {
    const category = error instanceof EmailServiceError ? error.category : 'unknown';
    process.stderr.write(`Email test failed (${category}).\n`);
    return 1;
  }
}

if (require.main === module) {
  void runEmailTest(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
