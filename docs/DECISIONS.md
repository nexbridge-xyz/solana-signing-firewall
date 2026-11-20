# Decisions

Decisions that shape Signing Firewall for Solana: what was decided, why, and where it applies.
When this file conflicts with other development instructions, this file wins.

## 2026-11-20

### D1. Name and identifiers

- Product name: **Signing Firewall for Solana**. Short name: **Signing Firewall**. Documents use the
  full name on first mention.
- Machine identifier: `solana-signing-firewall`. It is used for the repository, package names,
  schema IDs, the approval signing prefix and the verifier's reason prefix. The short name alone is
  already used by an unrelated project, and the approval prefix must be unambiguous because
  approvers sign it.
  - Packages, all `private` and not published: `@nexbridge/solana-signing-firewall`
    (`packages/signing-firewall`), `@nexbridge/solana-signing-firewall-x402`
    (`packages/signing-firewall-x402`), `@nexbridge/solana-signing-firewall-fixtures`
    (`packages/fixtures`).
  - Schemas: `solana-signing-firewall.policy/v0`, `solana-signing-firewall.approval/v0`,
    `solana-signing-firewall.x402-verifier/v0`.
  - Approval signing prefix: `solana-signing-firewall.approval/v0\n`.
  - Verifier rejection reason: `solana-signing-firewall:<CODE>`.
- Function and class names stay as designed: `review`, `withPolicy`, `createApproval`,
  `verifyApproval`, `createX402Guard`, `verifyX402Payment`, `withX402Verifier`,
  `x402RequirementsFilter`, `GuardedExactSvmScheme`, `PolicyViolationError`, `BudgetLedger`.

### D2. Versions and supply chain

- One `@solana/kit` for the whole workspace: 8.6.0. `@x402/svm` 2.31.0 declares
  `@solana/kit >=8.0.0` as a peer dependency, so the x402 glue shares it.
- Every `package.json` pins exact versions, and `pnpm-lock.yaml` is committed. pnpm refuses any
  package version published less than 7 days earlier (`minimumReleaseAge`). Dependency install
  scripts do not run.
- TypeScript 6.0.3, because typescript-eslint 8.72 does not support TypeScript 7.
- x402 rules follow the official `specs/schemes/exact/scheme_exact_svm.md` in
  `x402-foundation/x402`, commit `4f64aba41` (2026-11-06).

### D3. Memo program

Only the SPL Memo program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` counts as Memo. The x402
`exact` scheme names it, and the x402 SDK uses it. `@solana-program/memo` 0.16 exports it as
`LEGACY_MEMO_PROGRAM_ADDRESS_V3`; that package's `MEMO_PROGRAM_ADDRESS` now points to a newer,
upgradeable program. v0.1.0 treats the newer program, and the older v1 memo program, as unknown
programs (`PROGRAM_NOT_ALLOWED`).

### D4. Decoding

- Messages are parsed with `@solana/kit`'s compiled-message codec, then checked against the
  runtime's sanitization rules and the version-1 limits of SIMD-0385 (at most 64 accounts, 64
  instructions and 12 signatures; both priority-fee bits or neither; no unknown config bits; heap
  size a multiple of 1 KiB in [32 KiB, 256 KiB]). Trailing bytes are rejected.
- A decode problem is `MALFORMED_MESSAGE` or `UNSUPPORTED_VERSION`. When decoding fails, no other
  reason is reported.
- Lookup tables come only from the snapshot. A missing, foreign-owned, undecodable or deactivating
  table, or an entry not yet active at the snapshot slot, is `LOOKUP_TABLE_UNRESOLVED`. A
  deactivating table still resolves on chain for a while; we refuse it.
- Version-1 transactions put the signatures after the message (SIMD-0385). Wire bytes are always
  decoded with Kit's transaction decoder, never sliced by hand.

### D5. P-Token batch parser

- We parse `batch` (discriminator 255) ourselves and test the parser against the batch codec of
  `@solana-program/token` 0.18.0, which now ships its own parser.
- Sub-instructions see the outer account list with its signer and writable flags, consumed left
  to right (checked in the P-Token source, `pinocchio/program/src/processor/batch.rs`).
- Stricter than the program, and `MALFORMED_MESSAGE`: an empty batch, an entry with no data, and
  accounts that no entry consumes. The program ignores trailing accounts.
- A batch inside a batch is `TOKEN_INSTRUCTION_NOT_ALLOWED` at its path. The program refuses it too.

### D6. x402 message versions

- The guard and the verifier support version-0 and version-1 payments. The demo agent policy and
  the verifier config use `"messageVersions": ["v0", "v1"]`. The local facilitator advertises its
  default `[0, 1]`, so the SDK builds version 1.
- Version-1 payment fees are read only from `transactionConfig`. A version-1 payment that contains
  any ComputeBudget instruction is rejected. There is no exception for x402.
- Checked with `@x402/svm` 2.31.0 (`packages/signing-firewall-x402/scripts/probe-sdk-layout.ts`):
  version 1 builds `TransferChecked, Memo`, with `transactionConfig` priority fee 1 lamport,
  compute-unit limit 20,000 and loaded-accounts data size 4,194,304. Version 0 builds
  `SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo`. Neither differs from the spec.
- If version-1 settlement does not work on devnet, the local facilitator falls back to
  `transactionVersions: [0]`. Version-1 code and vectors stay, and SUPPORT_MATRIX and the video say
  that version-1 payments were tested only in vectors.

### D7. x402 Memo rule (`X402_MEMO_MISMATCH`)

The guard and the verifier check the Memo's content, not just its size:

- Exactly one SPL Memo instruction, after `TransferChecked`, with no accounts.
- When the requirements carry `extra.memo`, the Memo data must equal its UTF-8 bytes exactly.
  An `extra.memo` over 256 bytes makes the requirements malformed.
- Otherwise the data must be exactly 32 characters from `0-9a-f`: 16 random bytes, hex-encoded, as
  the reference SDK builds it. The spec asks for at least 16 bytes, hex-encoded. We also fix the
  length and the case, to keep the free-form content an agent signs at the minimum the spec allows.
- Why: if the SDK is replaced or has a bug, the Memo is where the agent's key would sign arbitrary
  content onto the chain.
- Vectors include at least: no Memo, two Memos, wrong content, wrong format. The transactions the
  SDK builds are `must_accept` vectors. If they ever disagree with the spec, work stops and the
  maintainers are told.

### D8. x402 layout and amount

- Transaction structure follows the spec (§1.3, §3.1). We accept a strict subset: version 0
  `SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo`; version 1
  `TransferChecked, Memo` with `computeUnitLimit` and `loadedAccountsDataSizeLimit` set. Lighthouse
  guard instructions, allowlisted instruction tuples and `CreateIdempotent` are rejected, and their
  vectors are marked `stricter_than_spec`.
- The amount must equal the quote. The spec tolerates overpayment (§1.4), so the overpayment vector
  is `stricter_than_spec`. The reference TypeScript facilitator's static path also requires equality.

### D9. x402 quote fields

- A non-empty `extra.splits` is rejected with `X402_SPLITS_NOT_ALLOWED`. Splits add payees that a
  `payTo` check alone would not see.
- `extra.ataCreationRequired: true` is rejected with `X402_CREATE_ATA_NOT_ALLOWED`.

### D10. Scene 13: hostile quotes

The SDK's spend controls keep their default (on). The second shop offers options the SDK lets
through where possible, so the guard stops them on the real payment path: the requirements filter
and the bound signer. Each option has exactly one fault:

1. 0.01 USDC to the outsider: `X402_PAYTO_NOT_ALLOWED`.
2. 0.01 USDC to the shop, with the agent itself as fee payer: `X402_FEE_PAYER_NOT_ALLOWED`.
3. 0.01 of a token the policy does not list, to the shop. If the SDK's spend controls drop it, the
   run shows that; otherwise the guard rejects it with `X402_ASSET_NOT_ALLOWED`.
4. 2.00 USDC to the outsider: shown as removed by the SDK's per-payment cap.

Printing each raw `PAYMENT-REQUIRED` option with our decision is explanation only; the blocking
happens on the real path. Narration: the SDK's default cap only limits the amount of each payment;
the payee, the asset, the fee payer and the cumulative budget are the guard's job.

### D11. Signer backends

- Public wording: "works in front of Keychain backends that sign the bytes they are given; tested
  with the memory backend". No count of backends anywhere: only the memory backend is tested, and
  Keychain adds and removes backends.
- SUPPORT_MATRIX marks every Keychain backend as tested, documented to work but not tested, or not
  supported, with the reason.
- A test shows that an inner signer returning a signature over different bytes is rejected with
  `SIGNATURE_INVALID`. This is how backends that rewrite the transaction (such as Fordefi native
  mode) are caught.
- `withPolicy()` refuses at construction an inner signer without `signTransactions`, such as a
  sending signer (Crossmint): `UNSUPPORTED_INNER_SIGNER`. Such signers broadcast the transaction
  themselves, so a signature check afterwards would be too late. A signer that cannot be
  recognized this way is listed as not supported.
- The wrapper implements `isAvailable()` by delegating to the inner signer, as Keychain's
  `SolanaTransactionSigner` requires.

### D12. Durable nonce replacement

Durable nonces are to be replaced by on-chain offline-signer programs (solana.com upgrade page
"Durable Nonce Deprecation", 2026-10-06, in development). Signatures for those programs have no
blockhash and stay valid until used or cancelled. THREAT_MODEL covers this. A core vector uses a
clearly labelled placeholder program to show that such an unknown program is denied
(`PROGRAM_NOT_ALLOWED`). It does not reproduce the real programs' addresses or message formats.

### D13. LiteSVM

LiteSVM 1.6.2's bundled programs execute a P-Token `batch` and a version-1 transaction
(`packages/fixtures/test/litesvm-capabilities.test.ts`). Integration tests run in LiteSVM; no
fallback is needed.
