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
- A security fix published less than 7 days ago may be installed as an exception, but only after
  the maintainers agree.
- TypeScript 6.0.3, because typescript-eslint 8.72 does not support TypeScript 7. The `DOM` lib is
  on, because Kit's WebCrypto types (`CryptoKey`, `CryptoKeyPair`) come from it.
- x402 rules follow the official `specs/schemes/exact/scheme_exact_svm.md` in
  `x402-foundation/x402`, commit `4f64aba41` (2026-11-06).

### D3. Memo program

Only the SPL Memo program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` counts as Memo. The x402
`exact` scheme names it, and the x402 SDK uses it. `@solana-program/memo` 0.16 exports it as
`LEGACY_MEMO_PROGRAM_ADDRESS_V3`; that package's `MEMO_PROGRAM_ADDRESS` now points to a newer,
upgradeable program. v0.1.0 treats the newer program, and the older v1 memo program, as unknown
programs (`PROGRAM_NOT_ALLOWED`); the reason carries the program address.

- A test checks that our Memo program address equals the one in the transactions the x402 SDK
  builds, so a change on either side turns the test red.
- `docs/X402.md` and `docs/SUPPORT_MATRIX.md` state these facts without judging either project.

### D4. Decoding

- Messages are parsed with `@solana/kit`'s compiled-message codec, then checked against the
  runtime's sanitization rules and the version-1 limits of SIMD-0385 (at most 64 accounts, 64
  instructions and 12 signatures; both priority-fee bits or neither; no unknown config bits; heap
  size a multiple of 1 KiB in [32 KiB, 256 KiB]). Trailing bytes are rejected. The bytes must be
  Kit's own encoding of what was decoded (D45), and the transaction must fit one packet with its
  signatures (D46).
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

The Memo's content is checked, not only its size. The two sides differ on purpose.

- **Guard (agent side).** Exactly one SPL Memo instruction, after `TransferChecked`, with no
  accounts. With `extra.memo`, its data must equal the UTF-8 bytes of `extra.memo` exactly (an
  `extra.memo` over 256 bytes makes the requirements malformed). Without it, the data must be
  exactly 32 characters from `0-9a-f`: 16 random bytes, hex-encoded, which is what the pinned SDK
  builds. A different format means the SDK was upgraded or altered, so refusing is right. Longer or
  upper-case hex is valid under the spec; those vectors are `stricter_than_spec`.
- **Verifier (facilitator side).** Only the conditions the spec states: a Memo may not come before
  the first `TransferChecked`; with `extra.memo`, exactly one Memo whose data equals it byte for
  byte; without it, at least one Memo whose data is a hex nonce of at least 32 characters. A
  facilitator takes payments from other x402 implementations, and a 32-character cap would refuse
  compliant ones; data hidden in a nonce is the payer's own risk. What the spec leaves open (letter
  case, odd length, an upper bound, the content of extra Memos) is listed as an open question in
  `docs/FIXTURES.md` and not enforced.
- **Why the guard is strict:** if the SDK is replaced or has a bug, the Memo is where the agent's
  key would sign arbitrary content onto the chain. THREAT_MODEL records what remains: an altered
  SDK can still carry 16 bytes out in each payment's nonce; the rate limit and the daily budget
  bound the total. (Corrected after the security review: that holds only for a quote without
  `extra.memo`. The guard gets the quote from the SDK, so an altered SDK, like a seller, can set
  `extra.memo` and have up to 256 bytes of its choosing signed in each payment; the policy's
  `memo.maxBytes` is the only bound. THREAT_MODEL now says so.)
- Vectors include at least: no Memo, two Memos, wrong content, wrong format. The transactions the
  SDK builds are `must_accept` vectors. If they ever disagree with the spec, work stops and the
  maintainers are told.

### D8. x402 layout and amount

- Transaction structure follows the spec (§1.3, §3.1). We accept a strict subset: version 0
  `SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo`; version 1
  `TransferChecked, Memo` with `computeUnitLimit` and `loadedAccountsDataSizeLimit` set. Lighthouse
  guard instructions, allowlisted instruction tuples and `CreateIdempotent` are rejected. No vector
  holds a Lighthouse instruction or an allowlisted tuple; the `CreateIdempotent` vector, x402-017,
  is `must_reject`, because §5.4 makes a sponsor refuse a creation nothing authorizes (D52).
- The amount must equal the quote. The spec tolerates overpayment (§1.4), so the overpayment vector
  is `stricter_than_spec`. The reference TypeScript facilitator's static path also requires equality.

### D9. x402 quote fields

- A non-empty `extra.splits` is rejected with `X402_SPLITS_NOT_ALLOWED`. Splits add payees that a
  `payTo` check alone would not see.
- `extra.ataCreationRequired: true` is rejected with `X402_CREATE_ATA_NOT_ALLOWED`.

### D10. Scene 13: hostile quotes

The SDK's spend controls keep their default (on). The second shop offers options the SDK lets
through where possible, so the guard stops them on the real payment path: the requirements filter
and the bound signer. Options 1 to 3 have exactly one fault each:

1. 0.01 USDC to the outsider: `X402_PAYTO_NOT_ALLOWED`.
2. 0.01 USDC to the shop, with the agent itself as fee payer: `X402_FEE_PAYER_NOT_ALLOWED`.
3. 0.01 of a token the policy does not list, to the shop. If the SDK's spend controls drop it, the
   run shows that; otherwise the guard rejects it with `X402_ASSET_NOT_ALLOWED`.
4. 2.00 USDC to the outsider: shown as removed by the SDK's per-payment cap. It has more than one
   fault: given to the guard, it would get `X402_PAYTO_NOT_ALLOWED`,
   `X402_PER_PAYMENT_LIMIT_EXCEEDED` and `X402_BUDGET_EXCEEDED`. The scene lists the vectors of
   options 1 to 3 (x402-036, x402-037, x402-035). (Corrected on 2026-11-21: this record and the
   scene said every option had one fault, and the scene also listed x402-038, another case.)

Option 3 uses the SDK's own devnet PYUSD default asset (read with `getDefaultAsset`, not typed
by hand). It is a default asset, so the SDK's spend controls let 0.01 through and the guard refuses
it. An offline test confirms the whole picture: options 1 to 3 reach the guard and fail with one
reason each; option 4 is removed by the SDK before the guard sees it.

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
  `SIGNATURE_INVALID`. (Corrected on 2026-11-20: Fordefi's native modes are not caught this way.
  They expose only `modifyAndSignTransactions` or `signAndSendTransactions`, so `withPolicy()`
  refuses them when it is created, as it refuses Crossmint. `SIGNATURE_INVALID` catches a
  transaction signer that returns a signature over other bytes.)
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

### D14. Snapshot: absent versus not fetched

In a snapshot, an address mapped to `null` was fetched and does not exist; an address missing from
the map was never fetched. A missing destination is then `DESTINATION_ACCOUNT_MISSING`, while state
the evaluation needs but never received is `ACCOUNT_STATE_MISSING`. `review()` never assumes.

### D15. `review()` is asynchronous

The associated-token-account check derives a PDA, which is asynchronous in Kit, so `review()`
returns a promise. It still makes no network calls. (Digests were asynchronous too at first; D23
made them synchronous.)

### D16. Policy format

- `parsePolicy()` is the schema: unknown fields are rejected, amounts are decimal strings within
  u64, and switches left out take their strict value (`tokenBatch: deny`, `durableNonce: deny`,
  memo off, associated token accounts required, explicit compute-unit limit required).
  `docs/POLICY.md` documents it; there is no separate JSON Schema file in v0.1.0.
- `approvalAbove` without an `approval` section is an error.
- `network` (`devnet`, `testnet`, `mainnet`, `localnet`) is checked by the RPC loader against the
  cluster's genesis hash; `localnet` skips the check, for LiteSVM and local validators.
- The policy digest is computed over the policy file's JSON as given, not over the filled-in form.

### D17. Approval records

- An approval carries `issuedAt` as well as `expiresAt`, so the policy's `ttlSeconds` can be checked
  when it is verified. An approval issued in the future, expiring before it was issued, or valid
  for longer than `ttlSeconds` is `APPROVAL_TTL_EXCEEDED` (a new code).
- Times are ISO 8601 UTC strings; the Ed25519 signature is base58.
- A malformed record is `APPROVAL_SIGNATURE_INVALID`.
- `createApproval()` needs only the two digests from the decision.

### D18. Fee rules

- With `requireExplicitComputeUnitLimit` (the default), any legacy or v0 message without a
  `SetComputeUnitLimit`, and any v1 message without `computeUnitLimit` in `transactionConfig`, is
  `COMPUTE_UNIT_LIMIT_MISSING`, whether or not it sets a price.
- Only a limit the message sets is compared with `maxComputeUnitLimit`.
- For the fee cap, a legacy or v0 message without a limit is costed at 1,400,000 units.

### D19. Instruction and transfer details

- The transfer authority must be the policy signer and must sign the message.
- A Memo's data must be valid UTF-8 and its only accounts the policy signer.
- Reasons carry `program` (for refused programs) and `account` (for the account a reason is about).

### D20. Runtime verdicts on core vectors

- Each core vector states `runtimeVerdict`: `runtime_accepts` or `runtime_rejects`, what the runtime
  does with the message signed by its required signers against the snapshot. A deny vector marked
  `runtime_accepts` is a check stricter than the runtime.
- A LiteSVM test sends every vector marked `runtimeCheckedBy: litesvm` as raw bytes and confirms the
  verdict; for each vector review() lets through, it also checks that token balances change by
  exactly the reviewed transfers.
- LiteSVM 1.6.2 aborts the process on bytes it cannot deserialize, so such vectors are
  `not_checked`, with a note. So is a vector whose program LiteSVM does not load (core-041). A
  vector whose snapshot leaves an account out on purpose is checked against that snapshot, which is
  what `runtimeVerdict` describes (core-068, D52).
- LiteSVM showed one expectation wrong: the token program does not check who owns the mint account
  (it matches the mint by address). `MINT_ACCOUNT_INVALID` for a mint with the wrong owner is
  therefore stricter than the runtime (core-045).

### D21. `withPolicy()` details

- It reviews every transaction in a call before the inner signer sees any of them, then calls the
  inner signer once. Each result must be exactly one signature, by the inner signer, valid over the
  reviewed message bytes, the wrapper's own copy of them (D41); anything else is
  `SIGNATURE_INVALID`.
- Approvals are found by message digest through an `approvals` lookup function.
- Keychain's Kit plugin builds signers from a backend configuration and cannot take an existing
  signer. As its documentation recommends for existing signers, the wrapped signer is installed with
  `@solana/kit-plugin-signer`. A test sends through such a client in LiteSVM, and the wrapper passes
  Keychain's `assertIsSolanaTransactionSigner`.

### D22. CI

On every push: install with the frozen lockfile, typecheck, lint, format check, tests with coverage
(including the LiteSVM tests), the vector diff, secret scanning and a dependency audit. Mutation
testing runs locally or by manual trigger only. Standard GitHub-hosted runners only, never larger
runners.

### D23. Synchronous digests

`x402Client.registerPolicy()` takes a synchronous function, so the quote checks that run inside it
cannot await. SHA-256 comes from `@noble/hashes` (synchronous); `policyDigest`, `requirementsDigest`
and `BudgetLedger.usage` are synchronous.

### D24. x402 vector format

- `specRules` cite sections of the official `scheme_exact_svm.md` (commit `4f64aba41`).
- `specVerdict`: `must_accept` meets every MUST of the spec; `must_reject` breaks a MUST that binds
  every facilitator (for a vector with only `expect.client`, every client); `stricter_than_spec`
  breaks none of those, and our guard or verifier refuses it. D52 gives the rule.
- `expect.client` is the guard: quote checks alone for vectors without a transaction, otherwise the
  full review of the bytes. `expect.facilitator` is the verifier. Attacks aimed at a facilitator
  (the fee payer as payer, a forged buyer signature) carry only the facilitator part.

### D25. Guard details

- The bound signer runs `review()`, the quote checks again, the binding checks and the Memo rule,
  then reserves the budget in one atomic step, and only then calls the key.
- x402 payments never wait for a person: an amount above `approvalAbove` is `APPROVAL_REQUIRED`.
- The daily budget is checked only for an allowed asset; an asset without a budget is refused.
- A quote whose `transactionVersions` share none with the policy's versions is
  `VERSION_NOT_ALLOWED`.

### D26. Verifier details

- The buyer is the transfer authority. Signers other than the buyer and the fee payer are checked
  only when a transfer was found; a payment without one is already refused.
- A Token-2022 payment is `TOKEN_PROGRAM_NOT_ALLOWED` in v0.1.0.
- A version-1 payment without `loadedAccountsDataSizeLimit` is `X402_LAYOUT_INVALID`; without a
  compute-unit limit, `COMPUTE_UNIT_LIMIT_MISSING`.

### D27. Budget ledger

- Per mint, a rolling 24-hour window; the rate limit counts all mints over 60 seconds.
- The file ledger is for Node.js and one process. Its lock file is removed by `close()` and when
  opening fails; after a crash it stays, and a person deletes it. Anyone who can edit the file can
  reset the budget.

### D28. Demo cast

- Fictional names, each searched on the web on 2026-11-20 with no company of that name found:
  Orrin & Vale (the company: treasury, finance approver, research agent), Thistledown Print
  (vendor A), Cobbleway Freight (vendor B), Lantern Row (the report shop). A candidate close to an
  existing logistics company's name was dropped. None comes from the Arbitrum demo.
- The second shop and the outsider have no name.

### D29. Devnet funds

- Setup asks the devnet RPC for one airdrop of 1 SOL, for the treasury, only when it holds less
  than 0.2 SOL, and never retries. If it is refused, setup stops and asks a person to use
  faucet.solana.com. Code never drives faucet.solana.com or faucet.circle.com.
- The treasury sends the local facilitator's fee payer 0.05 SOL instead of a second airdrop, so
  a run needs at most one airdrop request.
- Devnet USDC comes only from a person at faucet.circle.com, for the treasury address. Setup checks
  that the mint is an SPL Token mint with 6 decimals before it uses it.
- Budget of one full run: scenes 1 to 5 pay 7.00 USDC to the vendors; setup gives the agent
  0.10 USDC, of which a run spends 0.04. `pnpm demo:recycle` returns the vendors' and the shop's
  USDC to the treasury.

### D30. Setup accounts

- The outsider's second USDC account and the durable-nonce account are created with
  `CreateAccountWithSeed` from the treasury address, so their addresses follow from the keys and
  no extra key is needed.
- The lookup table holds the treasury's, both vendors' and the outsider's associated token
  accounts and the USDC mint. Setup waits until the confirmed slot is past its last extension.
- Setup is idempotent: it skips what exists, records what it sent in
  `docs/devnet-run/setup.json` as "setup, not a scene", and tops the agent up to 0.10 USDC.

### D31. Scene details

- ComputeBudget instructions come after the token instruction, so the batch in scene 9 is
  `ix[0]` and the reason path reads `ix[0].batch[1]`.
- Legacy and v0 scenes set a limit of 30,000 compute units; only scene 2 also sets a price, 1,000
  micro-lamports per unit (30 lamports). Version-1 scenes set
  30,000 compute units, 1 MiB of loaded account data and a 10,000-lamport priority fee; scene 11
  sets 5,000,000 lamports (0.005 SOL).
- Amounts chosen for the demo: scene 7 moves 1.00 USDC, scene 9's Approve allows 1,000 USDC,
  scene 11 moves 0.50 USDC.
- Scene 5's approval is valid for 60 seconds (the policy allows 90). Scene 6 presents it through
  an approval lookup that returns it for any message.
- Each scene wraps the treasury's Keychain signer afresh, so it counts only its own inner signer
  calls. Scene 15 counts the calls of the facilitator's key instead; the agent's guarded signer
  plays no part in it.

### D32. Run record

- `docs/devnet-run/run.json` holds, per scene, one or more steps (scene 5: first attempt, then
  after the approval; scene 14: second and third report), each with outcome, reasons, the reviewed
  message digest, signer calls, and for sent steps the signature and slot. x402 steps also hold
  every quote option with its digest; an option the SDK removed is marked as never seen by the
  guard. The policies used are written next to it.
- Each run starts a fresh budget file (`examples/x402-agent/.state/`, not committed), so every
  recorded run starts from the same daily budget.
- `pnpm demo:x402` writes `run-x402.json`, so it never replaces the full run.
- `pnpm verify-run` checks every step that has a signature and a reviewed digest: seven in a full
  run (scenes 1 to 5, 12 and 14).

### D33. Rehearsal

`pnpm demo:rehearse` and a test run the whole demo, setup to recycling, against a LiteSVM-backed
RPC on 127.0.0.1, with throwaway keys in a temporary directory that is deleted afterwards. The local
RPC ends a slot after each transaction, keeps SlotHashes current, and treats a request without a
commitment as `finalized`, as a cluster does. Explorer links are printed only for devnet.

### D34. Mutation testing

- StrykerJS 10.1.1 mutates `evaluate/`, `approval/` and `x402/` of the core library and runs the
  library's unit and property tests, the `@x402` glue tests and the two vector runners. The LiteSVM
  and rehearsal tests are left out: they are slow and test the runtime, not the checks.
- Stryker copies the project into a sandbox but links `node_modules` back to the original, so the
  mutation config aliases the library's package name to the sandbox copy; without it, the vector
  runners tested the unmutated library.
- A small ignorer plugin (`stryker-ignorers.mjs`) skips mutants in free text only: a reason's
  `detail` (not part of the stable interface) and the message of a thrown error. Every condition
  around that text is still mutated.
- No score is stated in the repository: the code has changed since the last run (D40 and after).
  To measure one, run `pnpm mutation` (StrykerJS; a full run takes hours, and the report is
  written to `reports/mutation/`), or start the manual workflow `.github/workflows/mutation.yml`.
- Found while writing the tests and fixed: the verifier config parser threw a `TypeError` instead of
  a `VerifierConfigError` for an asset rule that is not an object, and accepted an empty or array
  `assets`; it now refuses both and checks decimals are 0 to 255. A dead branch in the requirements
  parser was removed.

### D35. History stays as it is

The commit history is not rewritten and nothing is force-pushed, including the two early commits of
2026-11-20 that do not build on their own (`3cca400`, `6127227`, fixed by `49cf1d3`). The devnet
run record names the commit that produced it, and a rewrite would break that link.

### D36. Devnet run order

Setup, `pnpm demo`, `pnpm verify-run`, `pnpm demo:record`, then `pnpm demo:recycle` (it moves only
our own test USDC back to the treasury), then the commit of `docs/devnet-run/`. If a scene's result
on devnet differs from the local rehearsal, it is recorded as it happened, the run stops, and the
maintainers decide; the code is not changed to match a result.

### D37. Public RPC rate limits

The public devnet endpoint answered HTTP 429 during the first setup (after the facilitator's SOL
transfer had landed). From then on the demo commands repeat a request that got 429, to the RPC
URL only, at most 5 times after 1, 2, 4, 8 and 16 seconds; `requestAirdrop` is never repeated.
Repeating `sendTransaction` is safe: the same bytes carry the same signature, and the cluster
processes a signature once. Kit's HTTP transport calls the global `fetch`, so this covers the x402
SDK's RPC clients too. Confirmation and lookup-table polling slowed from 0.5 s to 1 s. The run
record is written after every scene, and a run that stops early keeps `complete: false` and the
error. None of this changes a scene's checks or expected result.

### D38. Secret scanning and the run record

gitleaks' `generic-api-key` rule reported the 14 decisions in `docs/devnet-run/run.json`: each
names its lifetime as `"token": "<blockhash>"`, and a blockhash is public chain data.
`.gitleaks.toml` keeps the default rules and allows, for that one rule and under `docs/devnet-run/`
only, every line that holds such a field: gitleaks matches the line, not the field, so a secret on
the same line would not be reported either, and a 32-byte seed in the field would pass. A 64-byte
secret key in base58 (87 or 88 characters) does not fit the field pattern; gitleaks' default rules
report it under a field name they recognize, but not under a neutral name or as a byte array.
`packages/fixtures/test/review-no-keys-in-history.test.ts` covers those cases: it finds key pairs and
seeds of known addresses by what they are, in every commit, and runs in CI (I-02). Before the
record was committed, a one-off check, not kept in the repository, looked for the eight demo keys
in it and in the terminal logs. CI runs gitleaks with `--verbose`, so a finding shows its rule and
file, with the secret redacted.

### D39. Release order

Decided by the maintainers on 2026-11-20, after the devnet run:

- The repository stays private for now: no `v0.1.0` tag, no private vulnerability reporting yet.
- Next, an independent security review, in a separate session with its own clone.
- After its fixes: if code the demo uses changed (`packages/` or `examples/`), the devnet demo is run
  again on the final commit, and `docs/devnet-run/` and `docs/video/` are updated. If only documents
  and tests changed, the run of 2026-11-20 stands.
- Then the video is recorded. Then, each only after asking the maintainers: make the repository
  public, turn on private vulnerability reporting, tag `v0.1.0`.
- Open before going public: check the README's quotation of Solana's x402 guide against the page.
  The wording comes from a maintainer's reading of the page; solana.com answered HTTP 429 to every
  fetch from this session.

### D40. Security review of 8a50ffc

On 2026-11-20 and 2026-11-21 a separate session, working in its own clone, reviewed commit
`8a50ffc` (D39). Its report is not in the repository. It numbers its findings `R-01` to `R-12`,
smaller items `I-01` to `I-13`, and the properties it checked and found holding `P-01` to `P-16`;
the commits and the records from here on use those numbers.

- The review's tests and fixes came as local branches. They were committed here one by one with
  the same changes, keeping each branch's order: the commit that adds a test comes first and the fix
  follows, so the test can be run against the old code at `<fix commit>~1`.
- The tests it added are the `review-*.test.ts` files. Those that passed at `8a50ffc` were committed
  first: messages fuzzed against LiteSVM, the paths that must fail closed, malformed input, the
  binding of an approval, the verifier against the static checks of the pinned `@x402/svm`
  facilitator, the demo commands against another cluster's genesis hash, and a search of the whole
  git history for private keys.
- `REVIEW_FUZZ_RUNS` sets the number of random cases of the two fuzzing tests
  (`packages/fixtures/test/review-runtime-differential.test.ts`,
  `packages/signing-firewall-x402/test/review-verifier-differential.test.ts`); 400 by default.

### D41. The wrappers sign their own copy of the reviewed bytes (R-01)

- `withPolicy()` and the x402 bound signer reviewed a copy of the message bytes, then gave the
  caller's own transaction objects to the inner signer and checked the returned signature against
  those objects. A caller that changed the bytes, swapped an array element or appended a
  transaction while the wrapper awaited got a valid signature over bytes `review()` had not
  allowed, and so did an inner signer that rewrote its input in place.
- Both wrappers now read each caller object once, before the first `await`
  (`holdTransactions()`), review, approve and verify their own copy, give the inner signer a second
  copy, and return the verified signatures in new objects. `signerFor()` binds to a JSON copy of
  the quote, not to the caller's object.
- `checkReturnedSignatures()`, which is exported, now takes the reviewed message bytes instead of
  the transactions, and returns the verified signatures.
- Tests: `packages/signing-firewall/test/review-toctou.test.ts`.

### D42. Lookup tables and a dishonest RPC (R-02)

- A version-0 message that uses a lookup table holds the table's address and an index, not the
  account. `review()` learns the account behind the index from the snapshot, that is, from the RPC,
  and the associated-token-account rule then checks that account. An RPC that reports false table
  contents makes `review()` allow a payment to one account while the runtime, which reads the real
  table, pays another. THREAT_MODEL said the rule prevents this; it now says the rule holds only
  for an address the message names itself.
- No code change in v0.1.0. `packages/fixtures/test/review-lookup-table-rpc.test.ts` shows the
  redirect in LiteSVM. THREAT_MODEL tells an operator whose RPC is not a node of their own to leave
  `v0` out of `messageVersions`, or to send version-0 messages that use no lookup table. x402
  payments already refuse lookup tables.
- Later work: a policy field that pins the lookup tables a signer accepts, with their entries, so
  that `review()` can refuse a table whose reported contents differ from the policy's.

### D43. A reservation dated after now still counts (R-03)

- `usageOf()` left out every reservation whose time was later than `now`. After one step back of
  the clock (an NTP step, a restored virtual machine, a clock set by hand), every reservation made
  since was in the future, and the whole daily budget and the rate limit were available again,
  without access to the ledger file.
- Such a reservation now counts in both windows, and so does a time that cannot be read. A clock
  that moves back cannot release a reservation. A reservation dated ahead by mistake keeps counting
  until a day after the time it names: that fails safe.
- The existing test that expected the future to be left out (`x402-ledger.test.ts`) was changed.
  New tests: `packages/signing-firewall/test/review-ledger-clock.test.ts`.

### D44. Approval times must be real instants (R-04)

- `issuedAt` and `expiresAt` were checked against a pattern only. `2026-11-20T23:59:60Z` (how a
  leap second is written), a 13th month or a 25th hour match it; `Date.parse()` answers NaN for
  them, every comparison with NaN is false, and such an approval never expired and skipped the ttl
  cap. `2026-02-30` was read as 2 March.
- A record is now malformed (`APPROVAL_SIGNATURE_INVALID`) unless each time names an instant that
  prints back as the same string, and the time checks are written so that NaN fails them, which
  also covers a `now` that is not a time.
- Such a record needs the approver's signature, so it is not a forgery, but any tool other than
  `createApproval()` can produce one, and a requester may prepare the record an approver signs.
- Tests: `packages/signing-firewall/test/review-approval-time.test.ts`.

### D45. Only the encoding the runtime reads (R-05)

- Kit's decoder reads an array whose length is missing at the end of the bytes as empty, and a
  length written in more bytes than it needs (`0x83 0x00` for 3). So `review()` allowed a version-0
  message without its lookup-table count, a legacy message without its instruction count, and
  padded lengths. The runtime cannot deserialize any of them, so nothing could execute, but the key
  signed bytes outside what the README calls supported.
- The decoder now requires the bytes to equal Kit's encoding of what it decoded
  (`MALFORMED_MESSAGE` otherwise).
- Tests: `packages/signing-firewall/test/review-decoder-canonical.test.ts`.

### D46. One packet (R-06)

- A cluster takes a transaction in one packet: at most 1,232 bytes for legacy and version 0, and
  4,096 for version 1, signatures included (Kit's `LEGACY_TRANSACTION_SIZE_LIMIT` and
  `V1_TRANSACTION_SIZE_LIMIT`). The x402 exact scheme for Solana states the same limits as a MUST
  (section 1.5). `review()` allowed larger messages, and `verifyX402Payment()` called larger
  payments valid.
- The decoder applies the limit with the other sanitization rules, counting one signature per
  required signer, so `review()`, the guard and the verifier refuse such a message as
  `MALFORMED_MESSAGE`.
- LiteSVM does not enforce the packet limit, so the tests rest on Kit's constants and the spec.
  What an RPC node answers for an oversized transaction was not tested.
- Tests: `packages/signing-firewall/test/review-decoder-size.test.ts`,
  `packages/signing-firewall-x402/test/review-verifier-size.test.ts`.

### D47. The Memo a seller or a replaced SDK chooses (R-07)

- THREAT_MODEL and D7 said a replaced SDK could carry out at most the 16 bytes of the nonce in each
  payment. The guard takes the quote from the SDK, so a replaced SDK, like a seller, can set
  `extra.memo` and have up to 256 bytes of any valid UTF-8 signed in each payment, control and
  invisible characters included. THREAT_MODEL, X402.md and D7 now say so. The bound an operator can
  set is the policy's `memo.maxBytes` (32 still admits the SDK's nonce and refuses longer seller
  memos).
- No code change in v0.1.0. `packages/signing-firewall/test/review-x402-memo.test.ts` shows what
  gets signed.
- Later work: a policy switch that refuses seller memos, or limits the characters they may hold.

### D48. A payment's version must be one the quote offers (R-08)

- The quote checks compared the quote with the policy, and `review()` compared the message with the
  policy; nothing compared the message with the quote. The bound signer signed version 1 for a quote
  that advertises `[0]` or nothing, version 0 for one that advertises `[1]`, and a legacy message
  when the policy listed `legacy`.
- The spec states it for the client: "Its message version MUST be one the requirements advertise in
  `extra.transactionVersions`, or version `0` when that field is absent (see §1.5)." (section
  "PaymentPayload `payload` Field"), and of legacy messages, "clients MUST NOT build them" (§1.5).
- The bound signer now refuses such a payment with `VERSION_NOT_ALLOWED`. The verifier is
  unchanged: "The sponsor enforces its own accepted set; it does not read
  `PaymentRequirements.extra.transactionVersions`." (§1.5)
- Tests: `packages/signing-firewall-x402/test/review-guard-version.test.ts`.

### D49. A repeated key in a policy file, and the policy's own copy (R-09)

- `JSON.parse()` keeps the last of two equal keys without a word, so a policy file could show a
  reader one value (the first `recipients`, say) and give the code another. `parsePolicyText(text)`
  reads a policy from the text of its file and refuses a key written twice, in escaped form too.
  Load policy files with it.
- `parsePolicy()` kept the caller's object and took the digest from it on every call, so changing
  that object afterwards changed the digest and not the rules. It now keeps a frozen copy of the
  JSON it is given, and refuses a value that is not plain JSON (a bigint, a cycle) with a
  `PolicyError`.
- The digest is unchanged: SHA-256 of the RFC 8785 canonical JSON of the parsed value (POLICY.md).
- Tests: `packages/signing-firewall/test/review-policy-file.test.ts`.

### D50. verify-run checks the cluster and the result, and reads no key (R-10)

- `pnpm verify-run` asked whatever RPC `.env` named for the recorded transactions, without the
  genesis-hash check the other demo commands make, so the RPC of another cluster (mainnet, under a
  URL that does not say so) was sent `getTransaction` requests. It counted a transaction whose
  message matched but that failed on chain as a match. And it needed the eight demo keys although
  it reads public data only, so it stopped in a fresh clone.
- It now checks the genesis hash before any other request (`verifyRun()` takes a `network`),
  reports a failed transaction as `FAILED ON CHAIN` instead of a match, and reads only
  `SOLANA_RPC_URL` from `.env` (devnet's public endpoint when there is none).
- Tests: `examples/devnet-payouts/test/review-verify-run.test.ts`.

### D51. review() returns a reason for account bytes that do not decode (R-11)

- A token-program account in the snapshot whose state byte is not 0, 1 or 2 made the codec throw
  inside `review()`. No signature followed, but `review()` is documented to return every failing
  reason.
- Such an account is now `SOURCE_ACCOUNT_INVALID`, `DESTINATION_ACCOUNT_INVALID` or
  `MINT_ACCOUNT_INVALID`.
- Tests: `packages/signing-firewall/test/review-snapshot-bytes.test.ts`.

### D52. Labels of the x402 vectors (R-12)

- Several x402 vectors were `must_reject` although the pinned spec has no MUST that binds every
  facilitator for them: the rule was stated only for the reference implementation's static path,
  held only under its default settings, or was not in the spec. A label now follows one rule:
  - `must_reject` only when the spec at `4f64aba41` has a sentence with MUST or MUST NOT that binds
    every facilitator (§2.1 binds every sponsor, and §2.1.5 brings in §1), or, for a vector with
    only `expect.client`, every client. `notes` give the section and the sentence.
  - `stricter_than_spec` for a rule stated only for the reference implementation's paths (§3), one
    that holds only under a default setting (`notes` name the setting), and one the spec does not
    state. `notes` name the decision.
  - Where the reading is not certain, the weaker label.
- Changed to `stricter_than_spec`: x402-010, 011, 013, 014, 015, 019, 020, 022, 023, 025, 026, 029
  and 044. Changed to `must_reject`: x402-031, under the client rule of §5.6. The quote-level vectors
  no longer cite §2.3, which is about sponsors; they cite the section of the field they test, or
  none.
- A client's own limits are not in the spec: the schemes, networks, assets, payees and fee payers it
  accepts, the cap per payment, the timeout, the daily budget and the rate limit. Their vectors
  (x402-033 to x402-043) are `stricter_than_spec` and cite this record.
- The labels and notes are in `packages/fixtures/src/x402/labels.ts`, one entry per vector. The
  runner checks reason codes, not labels.
- Also corrected: D8 said the Lighthouse, allow-list and `CreateIdempotent` vectors are
  `stricter_than_spec`; no vector holds the first two, and x402-017 is `must_reject`. `docs/X402.md`
  and `docs/FIXTURES.md` said the verifier enforces only what the spec states; D53 lists where it
  enforces more. core-068 recorded `runtime_accepts` for a snapshot against which the runtime
  rejects the transfer; it is now `runtime_rejects`, and LiteSVM checks it.

### D53. Where the verifier checks more than the spec

The verifier refuses some payments that no MUST binding every facilitator requires it to refuse.
Each has a `stricter_than_spec` vector:

- the quoted amount exactly (x402-008, D8);
- SPL Token only (x402-009, D26);
- the layouts of D8: no other token instruction beside the transfer, no P-Token `batch`, no Memo
  before the transfer (x402-010, x402-011, x402-029);
- the transaction's fee payer is `extra.feePayer` (x402-013);
- no durable nonce (x402-014);
- the compute-unit price within `maxComputeUnitPriceMicroLamports`, a cap the spec gives only as a
  setting of the reference implementation's static path (default 5,000,000 micro-lamports per
  unit), and the total priority fee within `maxPriorityFeeLamports`, a cap the spec does not have
  (x402-015);
- no lookup table (x402-018);
- a buyer signature that verifies (x402-019);
- an existing source account (x402-020), which is the associated token account of the transfer
  authority for the asset (x402-046, x402-048, D54);
- an amount in the quote that is a decimal string of base units, and not zero (x402-022, x402-039);
- without `extra.memo`, a Memo that holds a hex nonce of at least 32 characters; with it, exactly
  one Memo that equals it (x402-023, x402-025, x402-026; D7);
- a version-1 config that sets `computeUnitLimit` and `loadedAccountsDataSizeLimit` (x402-044,
  D26).

### D54. The source of an x402 payment, and every fee payer

- What the spec requires, §2.1.3: "The sponsor MUST reject any transaction in which the sponsor's
  funds could be debited beyond the network fee — including SOL transfers from sponsor-controlled
  accounts, token transfers for which the sponsor is the authority, or account closures/
  reallocations that move the sponsor's lamports." §2.1.1: "The `feePayer` MUST NOT be used as an
  authority, source, or delegate for any transfer." The spec says nothing else of the source
  account.
- What we check, in the guard and in the verifier (`bindingReasons()`):
  - The transfer's source is the associated token account of its authority for the quoted asset
    (`X402_SOURCE_NOT_PAYER_ATA`), as the destination must be that of `payTo`. This keeps out
    every source the buyer could only be a delegate of: the payee's own account, from which a
    transfer into itself pays the payee nothing (x402-046, `stricter_than_spec`), and a fee
    payer's account, which moves the sponsor's tokens (x402-047, `must_reject`). A token account
    of the buyer at another address is refused too (x402-048, `stricter_than_spec`).
  - No fee payer appears in an instruction's accounts or as its program: the message's own, and
    every other fee payer the verifier config or, in the guard, the policy lists
    (`X402_FEE_PAYER_IN_INSTRUCTION`; x402-049, `must_reject`). Before, only the message's fee
    payer was checked (I-11).
- In the guard, `review()` already required the source to be in the policy's `sources` and, by the
  snapshot, a token account of the policy signer for the mint. The guard now also requires it to be
  the signer's associated token account.
- `bindingReasons()`, which is exported, takes the fee payers to keep out of instructions.
- Tests: `packages/signing-firewall/test/x402-source-account.test.ts`.
