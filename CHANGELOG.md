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
- 69 core vectors and 49 x402 vectors, with a generator, a runner and LiteSVM checks of the runtime
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
- R-09: `parsePolicyText()` loads a policy file and refuses a key written twice; `parsePolicy()`
  keeps a frozen copy of the JSON it is given, so the digest always matches the rules.
- R-10: `pnpm verify-run` checks the cluster's genesis hash first, does not count a transaction that
  failed on chain, and needs no key. `verifyRun()` takes a `network`.
- R-11: `review()` returns `*_ACCOUNT_INVALID` for token account or mint bytes that do not decode,
  instead of throwing.
- R-12: the x402 vectors are labelled by one rule: `must_reject` only where the pinned spec has a
  MUST that binds every facilitator (or, for a client-only vector, every client), with the
  sentence in `notes`; otherwise `stricter_than_spec`, with the decision. Thirteen labels changed.
  core-068 records `runtime_rejects` for its own snapshot, and LiteSVM checks it.
- The guard and `verifyX402Payment()` require a payment's source to be the associated token
  account of its authority for the asset (`X402_SOURCE_NOT_PAYER_ATA`), and keep every fee payer
  the policy or the verifier config lists out of every instruction, not only the message's own
  (I-11). `bindingReasons()` takes those fee payers.
- I-03: demo setup records each transaction before it waits for the confirmation, and the lookup
  table's address before it sends it, so a lost confirmation creates nothing twice.
- I-04: `ensureKeys()` sets an existing `.env` back to mode 0600.
- I-09: an empty `extra.memo` counts as no seller memo.
- I-12: `withX402Verifier()` advertises only the message versions its verifier config accepts.
- I-13: the version-1 payment layout requires `computeUnitLimit`, in the guard as in the verifier.
- Documents: the statements the review found untrue or inexact are corrected, and no mutation score
  is stated until it is measured again (D55, D34).

### Fixed before the first release

- The verifier config parser threw a `TypeError` for an asset rule that is not an object, and
  accepted an empty `assets`.
- The demo commands now survive HTTP 429 from public RPC endpoints, and write the run record after
  every scene.
