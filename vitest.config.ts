import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/signing-firewall/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
});
