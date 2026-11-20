import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The tests Stryker runs for each mutant: the library's unit and property tests,
// the @x402 glue tests and the two vector runners. The LiteSVM and demo rehearsal
// tests are left out because they are slow and test the runtime, not the checks.
//
// Stryker copies the project into a sandbox but links node_modules back to the
// original, so an import by package name would load the original, unmutated
// library. The alias makes it load the sandbox copy, next to this file.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@nexbridge\/solana-signing-firewall$/,
        replacement: fileURLToPath(
          new URL('./packages/signing-firewall/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
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
