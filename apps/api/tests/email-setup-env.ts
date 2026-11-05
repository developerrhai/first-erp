export const EMAIL_TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/rhai_erp_test',
  JWT_ACCESS_SECRET: 'test-only-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  RATE_LIMIT_DISABLED: 'true',
};

Object.assign(process.env, EMAIL_TEST_ENV, {
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'email-test-user',
  SMTP_PASSWORD: 'email-test-password',
  EMAIL_FROM_ADMINISTRATION: 'administration@example.invalid',
});
