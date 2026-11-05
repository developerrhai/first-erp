import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/email-service.test.ts',
      'tests/email-api.test.ts',
      'tests/email-send-export.test.ts',
    ],
    setupFiles: ['tests/email-setup-env.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
