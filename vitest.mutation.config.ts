import { defineConfig } from 'vitest/config';

// The tests Stryker runs for each mutant: the library's unit and property tests,
// the @x402 glue tests and the two vector runners. The LiteSVM and demo rehearsal
// tests are left out because they are slow and test the runtime, not the checks.
export default defineConfig({
  test: {
    include: [
      'packages/signing-firewall/test/**/*.test.ts',
      'packages/signing-firewall-x402/test/**/*.test.ts',
      'packages/fixtures/test/core-vectors.test.ts',
      'packages/fixtures/test/x402-vectors.test.ts',
    ],
    testTimeout: 60_000,
  },
});
