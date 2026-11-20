# Changelog

All notable changes are listed here. The format follows Keep a Changelog; versions follow
Semantic Versioning. No version has been published to npm.

## Unreleased (0.1.0)

### Added

- `review()`: decodes legacy, version-0 and version-1 messages, resolves lookup tables from a
  snapshot, parses P-Token `batch`, and checks signers, fee payer, lifetime, programs,
  instructions, transfers, per-transaction totals and fees against a policy.
- Policy files (`solana-signing-firewall.policy/v0`) with strict defaults.
- Approvals for the exact message bytes: `createApproval()`, `verifyApproval()`.
- `withPolicy()`: wraps any Kit transaction partial signer, such as a Solana Keychain signer.
- `createRpcSnapshotLoader()` with a genesis-hash check, and `assertRpcNetwork()`.
- x402: quote checks, a single-use bound signer, memory and file budget ledgers, and
  `verifyX402Payment()` for facilitators; `x402RequirementsFilter`, `GuardedExactSvmScheme` and
  `withX402Verifier` for the `@x402` packages.
- 69 core vectors and 45 x402 vectors, with a generator, a runner and LiteSVM checks of the runtime
  verdict.
- The devnet demo (scenes 1 to 15), with a local rehearsal on LiteSVM, and its recorded devnet run
  of 2026-11-20 (`docs/devnet-run/`): 7 transactions sent, verify-run 7 of 7.
- Documentation: architecture, policy format, reason codes, vectors, x402, support matrix, threat
  model, decisions; video script, shots and captions.

### Fixed before the first release

- The verifier config parser threw a `TypeError` for an asset rule that is not an object, and
  accepted an empty `assets`.
- The demo commands now survive HTTP 429 from public RPC endpoints, and write the run record after
  every scene.
