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
  bound the total.
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
  `not_checked`, with a note. So are vectors whose program LiteSVM does not load, or whose state the
  snapshot omits on purpose.
- LiteSVM showed one expectation wrong: the token program does not check who owns the mint account
  (it matches the mint by address). `MINT_ACCOUNT_INVALID` for a mint with the wrong owner is
  therefore stricter than the runtime (core-045).

### D21. `withPolicy()` details

- It reviews every transaction in a call before the inner signer sees any of them, then calls the
  inner signer once. Each result must be exactly one signature, by the inner signer, valid over the
  reviewed message bytes; anything else is `SIGNATURE_INVALID`.
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
- `specVerdict`: `must_accept` meets every MUST of the spec; `must_reject` breaks one;
  `stricter_than_spec` meets the spec, but our guard or verifier refuses it.
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
- The file ledger is for Node.js and one process. Its lock file is never removed automatically:
  after a crash, a person deletes it. Anyone who can edit the file can reset the budget.

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
  `ix[0]` and the reason path reads `ix[0].batch[1]` as in the brief.
- Legacy and v0 scenes set 30,000 compute units at 1,000 micro-lamports. Version-1 scenes set
  30,000 compute units, 1 MiB of loaded account data and a 10,000-lamport priority fee; scene 11
  sets 5,000,000 lamports (0.005 SOL).
- Amounts the brief leaves open: scene 7 moves 1.00 USDC, scene 9's Approve allows 1,000 USDC,
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
- Score on 2026-11-20: 89.05% (target 85%). Most survivors left are equivalent mutants of checks
  that run twice on purpose (for example a reason both the quote checks and the bound signer would
  report) and of unreachable defensive branches in the guard.
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
names its lifetime as `"token": "<blockhash>"`, and a blockhash is public chain data. `.gitleaks.toml`
keeps the default rules and allows that one field, for that one rule, in the run record only; a
64-byte secret key in base58 (87 or 88 characters) is still reported. Before the record was
committed, a script checked that none of the eight demo keys appears in it or in the terminal logs.
CI now runs gitleaks with `--verbose`, so a finding shows its rule and file, with the secret
redacted.

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
