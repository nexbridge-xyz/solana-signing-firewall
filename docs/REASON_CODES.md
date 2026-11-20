# Reason codes

Every refusal carries one or more reasons. A reason has a stable `code`, and may carry `path`
(where in the message, for example `ix[1]` or `ix[0].batch[2]`), `program` (a refused program),
`account` (the account it is about) and `detail` (free text, not part of the stable interface).
`review()` reports every failing check, not only the first; when the message does not decode, it
reports only the decode problem.

Codes may be added after v0.1.0; none will be renamed. The verifier returns a code to x402 clients
as `invalidReason: "solana-signing-firewall:<CODE>"`.

Raised by: **review** (`review()` and `withPolicy()`), **approval** (`verifyApproval()`),
**wrapper** (`withPolicy()` itself), **guard** (the x402 guard: quote checks and the bound signer),
**verifier** (`verifyX402Payment()` and `withX402Verifier()`). The guard runs `review()` on
every payment, so any code marked review can also come from the guard. A test
(`packages/fixtures/test/reason-codes-doc.test.ts`) checks that this file lists every code once and
that each listed vector expects its code.

## Message format

| Code                      | Meaning                                                                                                                                                         | Raised by               | Vectors                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `UNSUPPORTED_VERSION`     | The version byte names a message version that does not exist.                                                                                                   | review, verifier        | core-006                               |
| `VERSION_NOT_ALLOWED`     | The message version is not in `messageVersions`; for x402, no version the quote offers is, or the payment's version is not among the versions the quote offers. | review, guard, verifier | core-069                               |
| `MALFORMED_MESSAGE`       | The bytes do not decode, break a runtime sanitization rule or a version-1 limit, are too large for one packet, have trailing bytes, or hold a malformed batch.  | review, verifier        | core-007, core-008, core-009, core-013 |
| `LOOKUP_TABLE_UNRESOLVED` | A lookup table is missing from the snapshot, foreign-owned, undecodable or deactivating, or an entry is out of range or not yet active.                         | review, verifier        | core-015, core-024                     |

## Fee payer and signers

| Code                    | Meaning                                                                                          | Raised by               | Vectors                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------- |
| `FEE_PAYER_NOT_ALLOWED` | The fee payer is not in `feePayers`.                                                             | review, guard           | core-025, x402-013           |
| `UNEXPECTED_SIGNER`     | The message requires a signature from an account other than the policy signer and the fee payer. | review, guard, verifier | core-026, core-043, x402-021 |
| `SIGNER_NOT_REQUIRED`   | The policy signer is not a required signer of the message.                                       | review, guard           | core-027, x402-005           |

## Lifetime

| Code                        | Meaning                               | Raised by               | Vectors            |
| --------------------------- | ------------------------------------- | ----------------------- | ------------------ |
| `DURABLE_NONCE_NOT_ALLOWED` | The message advances a durable nonce. | review, guard, verifier | core-028, x402-014 |

## Instructions

| Code                                     | Meaning                                                                                                                             | Raised by               | Vectors                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `TOKEN_BATCH_NOT_ALLOWED`                | A P-Token `batch` under `tokenBatch: deny`.                                                                                         | review, guard           | core-031, x402-011                     |
| `TOKEN_INSTRUCTION_NOT_ALLOWED`          | An SPL Token instruction other than `TransferChecked`, at top level or inside a batch.                                              | review, guard           | core-030, core-032, core-033, x402-004 |
| `TOKEN_PROGRAM_NOT_ALLOWED`              | A Token-2022 instruction. v0.1.0 supports SPL Token only.                                                                           | review, guard, verifier | core-034, x402-009                     |
| `COMPUTE_BUDGET_INSTRUCTION_NOT_ALLOWED` | A ComputeBudget instruction other than one `SetComputeUnitLimit` and one `SetComputeUnitPrice`.                                     | review                  | core-035, core-036                     |
| `COMPUTE_BUDGET_INSTRUCTION_IN_V1`       | A ComputeBudget instruction in a version-1 message, where the runtime ignores it.                                                   | review, guard, verifier | core-037, x402-016                     |
| `MEMO_NOT_ALLOWED`                       | A Memo the policy does not allow: memos off, longer than `memo.maxBytes`, not UTF-8, or with accounts other than the policy signer. | review                  | core-038                               |
| `SYSTEM_INSTRUCTION_NOT_ALLOWED`         | A System Program instruction. A nonce advance is reported as `DURABLE_NONCE_NOT_ALLOWED` instead.                                   | review                  | core-040                               |
| `PROGRAM_NOT_ALLOWED`                    | An instruction to any other program, including the newer Memo program. The reason carries the program address.                      | review, guard           | core-029, core-041, x402-017           |

## Transfers

| Code                                       | Meaning                                                                                                                                  | Raised by               | Vectors                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `AUTHORITY_NOT_POLICY_SIGNER`              | The transfer authority is not the policy signer.                                                                                         | review                  | core-042                               |
| `MULTISIG_AUTHORITY_NOT_SUPPORTED`         | A `TransferChecked` lists multisig co-signers.                                                                                           | review                  | core-043                               |
| `MINT_NOT_ALLOWED`                         | The mint is not in `mints`.                                                                                                              | review, guard           | core-044, x402-045                     |
| `MINT_ACCOUNT_INVALID`                     | The mint account is missing, not owned by SPL Token, not a mint, or not initialized. The owner check is stricter than the runtime (D20). | review                  | core-045                               |
| `DECIMALS_MISMATCH`                        | The instruction's decimals differ from the policy's or the mint's.                                                                       | review, verifier        | core-046                               |
| `SOURCE_NOT_ALLOWED`                       | The source token account is not in `sources`.                                                                                            | review                  | core-042, core-044, core-047           |
| `SOURCE_ACCOUNT_INVALID`                   | The source is missing, not an initialized SPL Token account, holds another mint, or is not owned by the policy signer.                   | review, guard           | core-042, core-047, x402-020           |
| `ACCOUNT_FROZEN`                           | The source or the destination is frozen.                                                                                                 | review                  | core-048                               |
| `DESTINATION_ACCOUNT_MISSING`              | The destination was fetched and does not exist.                                                                                          | review, verifier        | core-049                               |
| `DESTINATION_ACCOUNT_INVALID`              | The destination exists but is not an initialized SPL Token account.                                                                      | review                  | core-050                               |
| `DESTINATION_MINT_MISMATCH`                | The destination holds another mint.                                                                                                      | review, guard           | core-051, x402-045                     |
| `RECIPIENT_NOT_ALLOWED`                    | The destination's owner is not in `recipients.owners`.                                                                                   | review, guard           | core-052, core-053, x402-006           |
| `DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT` | The destination is not its owner's associated token account for the mint.                                                                | review, guard           | core-052, x402-045                     |
| `ZERO_AMOUNT`                              | A transfer, or an x402 quote, of zero.                                                                                                   | review, guard, verifier | core-054, x402-039                     |
| `PER_TRANSACTION_LIMIT_EXCEEDED`           | The sum of one mint's transfers in the message, batches included, is above `maxPerTransaction` or overflows a u64.                       | review                  | core-059, core-060, core-061, core-062 |

## Fees

| Code                          | Meaning                                                                                           | Raised by               | Vectors                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| `COMPUTE_UNIT_LIMIT_MISSING`  | The message sets no compute-unit limit while one is required.                                     | review, verifier        | core-063, core-067                     |
| `COMPUTE_UNIT_LIMIT_EXCEEDED` | The limit the message sets is above `maxComputeUnitLimit`.                                        | review, verifier        | core-064                               |
| `FEE_CAP_EXCEEDED`            | The total priority fee is above the policy's (or the verifier config's) `maxPriorityFeeLamports`. | review, guard, verifier | core-037, core-065, x402-015, x402-016 |

## State

| Code                    | Meaning                                                                               | Raised by        | Vectors  |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------- | -------- |
| `ACCOUNT_STATE_MISSING` | The evaluation needs an account the snapshot never fetched. `review()` never assumes. | review, verifier | core-068 |

## Approvals

| Code                         | Meaning                                                                                                                                                               | Raised by       | Vectors            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------ |
| `APPROVAL_REQUIRED`          | The total is above `approvalAbove` and no approval was presented. An x402 payment above `approvalAbove` is refused with it, because payments never wait for a person. | approval, guard | core-005, core-056 |
| `APPROVAL_SIGNATURE_INVALID` | The approval record is malformed, or its signature does not verify.                                                                                                   | approval        | core-021           |
| `APPROVER_NOT_ALLOWED`       | The approval is signed by someone not in `approval.approvers`.                                                                                                        | approval        | core-018           |
| `APPROVAL_EXPIRED`           | The approval's `expiresAt` has passed.                                                                                                                                | approval        | core-017           |
| `APPROVAL_MESSAGE_MISMATCH`  | The approval names another message digest.                                                                                                                            | approval        | core-019           |
| `APPROVAL_POLICY_MISMATCH`   | The approval names another policy digest.                                                                                                                             | approval        | core-020           |
| `APPROVAL_TTL_EXCEEDED`      | The approval was issued in the future, expires before it was issued, or is valid for longer than `ttlSeconds`.                                                        | approval        | core-022           |

## Signer wrapper

These are about the inner signer, not about message bytes, so unit tests cover them instead of
vectors.

| Code                       | Meaning                                                                                                                 | Raised by | Vectors                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| `SIGNER_ADDRESS_MISMATCH`  | The inner signer's address is not the policy signer.                                                                    | wrapper   | unit test: `packages/signing-firewall/test/with-policy.test.ts` |
| `UNSUPPORTED_INNER_SIGNER` | The inner signer cannot return signatures (for example a sending signer); `withPolicy()` refuses it when it is created. | wrapper   | unit test: `packages/signing-firewall/test/with-policy.test.ts` |
| `SIGNATURE_INVALID`        | The inner signer returned anything other than exactly one valid signature, its own, over the reviewed bytes.            | wrapper   | unit test: `packages/signing-firewall/test/with-policy.test.ts` |

## x402: the quote

| Code                              | Meaning                                                                                                                       | Raised by       | Vectors            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------ |
| `X402_REQUIREMENTS_MALFORMED`     | The payment requirements are not valid, for example an amount that is not a decimal string or an `extra.memo` over 256 bytes. | guard, verifier | x402-022           |
| `X402_SCHEME_NOT_ALLOWED`         | The scheme is not in `x402.schemes`.                                                                                          | guard, verifier | x402-033           |
| `X402_NETWORK_NOT_ALLOWED`        | The network is not in `x402.networks`.                                                                                        | guard, verifier | x402-034           |
| `X402_ASSET_NOT_ALLOWED`          | The asset has no rule in the policy, or is not in the verifier config's assets.                                               | guard, verifier | x402-009, x402-035 |
| `X402_PAYTO_NOT_ALLOWED`          | The payee is not in `recipients.owners`.                                                                                      | guard           | x402-036           |
| `X402_FEE_PAYER_NOT_ALLOWED`      | The quote names no fee payer, names the agent itself, or names one not in `feePayers`.                                        | guard, verifier | x402-037, x402-043 |
| `X402_PER_PAYMENT_LIMIT_EXCEEDED` | The amount is above the mint's `maxPerTransaction`.                                                                           | guard           | x402-038           |
| `X402_TIMEOUT_OUT_OF_RANGE`       | `maxTimeoutSeconds` is above the policy's.                                                                                    | guard           | x402-040           |
| `X402_BUDGET_EXCEEDED`            | The payment would take the rolling 24-hour total for the mint above `maxPerDay`.                                              | guard           | x402-041           |
| `X402_RATE_LIMIT_EXCEEDED`        | `maxPaymentsPerMinute` payments were already made in the last 60 seconds.                                                     | guard           | x402-042           |
| `X402_SPLITS_NOT_ALLOWED`         | The quote has a non-empty `extra.splits`.                                                                                     | guard, verifier | x402-031           |

## x402: the bytes against the quote

| Code                               | Meaning                                                                                                                                                                                                                    | Raised by       | Vectors                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| `X402_LAYOUT_INVALID`              | The instructions are not an accepted layout: version 0 `SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo`; version 1 `TransferChecked, Memo` with `computeUnitLimit` and `loadedAccountsDataSizeLimit` set. | guard, verifier | x402-005, x402-010, x402-029, x402-044                   |
| `X402_NOT_TRANSFER_CHECKED`        | The payment's token instruction is not `TransferChecked`, for example `ApproveChecked` or a transfer inside a batch.                                                                                                       | guard, verifier | x402-004, x402-011                                       |
| `X402_AMOUNT_MISMATCH`             | The amount differs from the quote. Overpayment counts too, which is stricter than the spec.                                                                                                                                | guard, verifier | x402-007, x402-008                                       |
| `X402_MINT_MISMATCH`               | The transfer moves another mint than the quoted asset.                                                                                                                                                                     | guard, verifier | x402-045                                                 |
| `X402_DESTINATION_NOT_PAYTO_ATA`   | The destination is not the associated token account of `payTo` for the asset.                                                                                                                                              | guard, verifier | x402-006                                                 |
| `X402_FEE_PAYER_MISMATCH`          | The fee payer is not the quote's `extra.feePayer`.                                                                                                                                                                         | guard, verifier | x402-013                                                 |
| `X402_FEE_PAYER_IN_INSTRUCTION`    | The fee payer appears in an instruction's accounts or as its program.                                                                                                                                                      | guard, verifier | x402-012, x402-017                                       |
| `X402_COMPUTE_UNIT_PRICE_EXCEEDED` | The compute-unit price is above the cap; for version 1, `priorityFee × 1,000,000 > cap × computeUnitLimit`.                                                                                                                | guard, verifier | x402-015, x402-016                                       |
| `X402_CREATE_ATA_NOT_ALLOWED`      | The quote asks for the seller's token account to be created, or the transaction creates it.                                                                                                                                | guard, verifier | x402-017, x402-032                                       |
| `X402_LOOKUP_TABLE_NOT_ALLOWED`    | The payment loads accounts from a lookup table.                                                                                                                                                                            | guard, verifier | x402-018                                                 |
| `X402_MEMO_MISMATCH`               | The Memo is missing, doubled, has the wrong content or the wrong format. Guard and verifier apply different rules (D7).                                                                                                    | guard, verifier | x402-023, x402-025, x402-026                             |
| `X402_SIGNER_ALREADY_USED`         | The single-use signer bound to one quote was asked to sign again.                                                                                                                                                          | guard           | unit test: `packages/signing-firewall/test/x402.test.ts` |

## x402: facilitator side

| Code                           | Meaning                                                 | Raised by | Vectors  |
| ------------------------------ | ------------------------------------------------------- | --------- | -------- |
| `X402_PAYER_SIGNATURE_INVALID` | The buyer's signature does not verify over the message. | verifier  | x402-019 |
| `X402_SOURCE_ACCOUNT_MISSING`  | The buyer's token account does not exist.               | verifier  | x402-020 |
