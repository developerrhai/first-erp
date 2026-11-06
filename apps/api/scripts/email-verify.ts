import path from 'node:path';
import { EmailServiceError, verifySmtpConnection } from '../src/core/email/email-service';

export async function runEmailVerify(
  verify: typeof verifySmtpConnection = verifySmtpConnection,
): Promise<number> {
  try {
    await verify('Administration');
    process.stdout.write('SMTP connection verified for the Administration test sender.\n');
    return 0;
  } catch (error) {
    const category = error instanceof EmailServiceError ? error.category : 'unknown';
    process.stderr.write(`SMTP verification failed (${category}).\n`);
    return 1;
  }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScript === path.resolve(process.cwd(), 'scripts', 'email-verify.ts')) {
  void runEmailVerify().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
