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

### Fixed after the security review of 8a50ffc

Numbers refer to the review (`docs/DECISIONS.md`, D40 and after).

- R-01: `withPolicy()` and the x402 bound signer sign and verify their own copy of the reviewed
  bytes; a caller that changed its transaction objects during the review could get unreviewed
  bytes signed. `checkReturnedSignatures()` now takes the reviewed message bytes and returns the
  verified signatures.
- R-02: THREAT_MODEL no longer says the associated-token-account rule stops a dishonest RPC from
  redirecting a payment through a lookup table, and says what to do instead.
- R-03: a reservation dated after now (a clock that moved back) still counts towards the daily
  budget and the rate limit.
- R-04: an approval whose `issuedAt` or `expiresAt` is not a real instant (a 61st second, a 13th
  month, 30 February) is refused as malformed; before, it never expired.
- R-05: `review()` refuses message encodings the runtime cannot read: a length missing at the end,
  or a length not written in its shortest form.
- R-06: `review()`, the guard and `verifyX402Payment()` refuse a transaction too large for one
  packet (1,232 bytes, or 4,096 for version 1, signatures included).
- R-07: THREAT_MODEL and X402.md say that a seller, or a replaced SDK, can choose up to 256 bytes
  of Memo text for the agent's key to sign in each payment, and that `memo.maxBytes` bounds it.
- R-08: the bound signer refuses a payment whose message version the quote does not offer, and a
  legacy payment (`VERSION_NOT_ALLOWED`).

### Fixed before the first release

- The verifier config parser threw a `TypeError` for an asset rule that is not an object, and
  accepted an empty `assets`.
- The demo commands now survive HTTP 429 from public RPC endpoints, and write the run record after
  every scene.
