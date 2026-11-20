# Support matrix

What v0.1.0 handles, what was tested and how. "Refused" means `review()` denies it with the reason
shown; nothing here is silently ignored.

## Versions tested

| Component                                                 | Version                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| Node.js                                                   | 22                                                             |
| `@solana/kit`                                             | 8.6.0 (one copy for the whole workspace)                       |
| `@solana-program/token`                                   | 0.18.0                                                         |
| `@solana/keychain`, `@solana/keychain-memory`             | 2.0.0                                                          |
| `@x402/core`, `@x402/fetch`, `@x402/express`, `@x402/svm` | 2.31.0 (2.23.0 or later only)                                  |
| LiteSVM (`litesvm`)                                       | 1.6.2                                                          |
| x402 `exact` scheme on Solana                             | `scheme_exact_svm.md`, x402-foundation/x402 commit `4f64aba41` |

## Messages

| Message               | Status    | Notes                                                                                                                                         |
| --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy                | supported |                                                                                                                                               |
| Version 0             | supported | Lookup tables resolved from the snapshot only; a deactivating table is refused (`LOOKUP_TABLE_UNRESOLVED`).                                   |
| Version 1 (SIMD-0385) | supported | Fees from `transactionConfig`; ComputeBudget instructions refused (`COMPUTE_BUDGET_INSTRUCTION_IN_V1`). Decoding checks the version-1 limits. |
| Durable nonce         | refused   | `DURABLE_NONCE_NOT_ALLOWED`, in every version.                                                                                                |
| Unknown versions      | refused   | `UNSUPPORTED_VERSION`.                                                                                                                        |

## Instructions

| Program and instruction                                                                                | Status                                      | Reason when refused                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------- |
| SPL Token `TransferChecked`                                                                            | supported                                   |                                                                |
| P-Token `batch` of `TransferChecked`                                                                   | supported with `tokenBatch: transfers-only` | `TOKEN_BATCH_NOT_ALLOWED` otherwise                            |
| Any other SPL Token instruction, at top level or in a batch                                            | refused                                     | `TOKEN_INSTRUCTION_NOT_ALLOWED`                                |
| Token-2022                                                                                             | refused in v0.1.0 (roadmap)                 | `TOKEN_PROGRAM_NOT_ALLOWED`                                    |
| Multisig transfer authority                                                                            | refused                                     | `MULTISIG_AUTHORITY_NOT_SUPPORTED`                             |
| ComputeBudget `SetComputeUnitLimit`, `SetComputeUnitPrice` (one each)                                  | supported in legacy and version 0           | `COMPUTE_BUDGET_INSTRUCTION_NOT_ALLOWED` for others or repeats |
| SPL Memo `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`                                                 | supported when the policy allows memos      | `MEMO_NOT_ALLOWED`                                             |
| The newer Memo program (`MEMO_PROGRAM_ADDRESS` of `@solana-program/memo` 0.16) and the v1 Memo program | refused                                     | `PROGRAM_NOT_ALLOWED`, with the program address                |
| System Program                                                                                         | refused                                     | `SYSTEM_INSTRUCTION_NOT_ALLOWED`                               |
| Any other program                                                                                      | refused                                     | `PROGRAM_NOT_ALLOWED`, with the program address                |

About Memo: the x402 `exact` scheme names the SPL Memo program, and `@x402/svm` uses it. Since
`@solana-program/memo` 0.16, that package's `MEMO_PROGRAM_ADDRESS` names a newer, upgradeable
program, and the SPL Memo address is exported as `LEGACY_MEMO_PROGRAM_ADDRESS_V3`. Signing
Firewall takes the address from that export, and a test compares it with the transactions the x402
SDK builds.

## Signers

`withPolicy()` and the x402 guard take any Kit `TransactionPartialSigner`: a signer that returns
signatures over the bytes it is given. They work in front of Keychain backends that sign the bytes
they are given; they were tested with the memory backend. Each returned signature is verified over
the wrapper's own copy of the reviewed bytes (the signer is handed a second copy), so a signer that
signs anything else is refused (`SIGNATURE_INVALID`). A signer
without `signTransactions` is refused when the wrapper is created (`UNSUPPORTED_INNER_SIGNER`): it
would send or rewrite the transaction itself, and a check afterwards would be too late.

Keychain 2.0.0 backends, by what `createKeychainSigner()` returns:

| Backend                                                                                                     | Status                         | Why                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`                                                                                                    | tested                         | Unit and integration tests, LiteSVM, the local rehearsal, and the devnet run of 2026-11-20 (docs/devnet-run).                                                               |
| `aws-kms`, `cdp`, `dfns`, `fireblocks`, `gcp-kms`, `openfort`, `para`, `privy`, `turnkey`, `utila`, `vault` | documented to work, not tested | Each is a transaction partial signer, which signs the bytes it is given. Not run here: each needs an account with its provider.                                             |
| `fordefi` without `chain` (black-box mode)                                                                  | documented to work, not tested | A transaction partial signer over the caller's exact bytes.                                                                                                                 |
| `fordefi` with `chain` (native modes)                                                                       | not supported                  | Manual mode only rewrites and signs (`modifyAndSignTransactions`); automatic mode rewrites and broadcasts (`signAndSendTransactions`). Refused when the wrapper is created. |
| `crossmint`                                                                                                 | not supported                  | A sending signer: it broadcasts the transaction itself. Refused when the wrapper is created.                                                                                |

## x402

| Item                                               | Status                                                            | Notes                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Scheme `exact`                                     | supported                                                         | Other schemes refused (`X402_SCHEME_NOT_ALLOWED`).                                                                  |
| Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) | tested on devnet                                                  | The devnet run of 2026-11-20: two payments settled by the local facilitator.                                        |
| Mainnet                                            | not tested                                                        | No request of any kind was made to mainnet.                                                                         |
| Version-0 payments                                 | tested in vectors and locally                                     |                                                                                                                     |
| Version-1 payments                                 | tested in vectors, locally and on devnet                          | Both settlements of the 2026-11-20 devnet run are version-1 transactions.                                           |
| SPL Token assets                                   | supported                                                         |                                                                                                                     |
| Token-2022 assets                                  | refused in v0.1.0, by the guard and by the verifier               | `TOKEN_PROGRAM_NOT_ALLOWED`. A facilitator wrapped with `withX402Verifier()` refuses Token-2022 payments too (D26). |
| Splits, seller account creation, lookup tables     | refused                                                           | Stricter than the spec (docs/X402.md).                                                                              |
| Payment above `approvalAbove`                      | refused                                                           | `APPROVAL_REQUIRED`. v0.1.0 has no human approval for x402: a payment never waits for a person (D25).               |
| Budget ledger                                      | memory, or a file for one Node.js process                         | One process only. Anyone who can edit the file can reset the budget (D27).                                          |
| Client SDK                                         | `@x402/fetch` with `GuardedExactSvmScheme`                        |                                                                                                                     |
| Facilitator                                        | any `SchemeNetworkFacilitator`, wrapped with `withX402Verifier()` | Tested with the `@x402/svm` facilitator scheme.                                                                     |

## Networks

The demo and every integration test run on devnet or locally (LiteSVM). A policy names its network,
and the RPC loader refuses an RPC whose genesis hash belongs to another cluster.
