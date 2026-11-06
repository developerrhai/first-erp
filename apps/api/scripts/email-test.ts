import path from 'node:path';
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

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScript === path.resolve(process.cwd(), 'scripts', 'email-test.ts')) {
  void runEmailTest(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
