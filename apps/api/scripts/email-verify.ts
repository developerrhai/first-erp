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

if (require.main === module) {
  void runEmailVerify().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
