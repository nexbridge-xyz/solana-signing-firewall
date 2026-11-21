Recorded on devnet, 2026-11-21T05:47:10.917Z, from commit 8d92d862ed5f. Signer: Solana Keychain (memory backend), wrapped by Signing Firewall.

| # | Scene | Result | Reasons | Inner signer calls | Vectors | Transaction |
|---|---|---|---|---|---|---|
| 1 | Legacy transfer: 1.00 USDC to Thistledown Print (vendor A) | allow | - | 1 | core-001 | [slot 524612068](https://explorer.solana.com/tx/5DAYN3Wu9jSYzZJDD24P7mXc6PcUoMqjDX2kc4KdUYm3szCZbmHgzoJVvT5PSKYBfmXpUextJkHQrDuzBoXdGAqH?cluster=devnet) |
| 2 | v0 transfer through the lookup table: 1.50 USDC to Cobbleway Freight (vendor B) | allow | - | 1 | core-002 | [slot 524612074](https://explorer.solana.com/tx/DLw9mgqAV7wKgnxe7Q9Fin5W4THiE73cWUB5av59YNVWMB1MiyVRPaZXLARCuNFAuyQb32UkJPHfSZ3JACh1ooB?cluster=devnet) |
| 3 | v1 transfer: 0.50 USDC to Thistledown Print (vendor A), priority fee within the cap | allow | - | 1 | core-003 | [slot 524612080](https://explorer.solana.com/tx/2GvC2QcuwMhBrVw7yAse8rBSZanQ2nFS8zkVn5bY95yYPkfkTEUo2JWYwvLv5ykpubvKXwEkmLU2w3fmq4M7khEP?cluster=devnet) |
| 4 | P-Token batch: 0.40 USDC to Thistledown Print (vendor A) and 0.60 USDC to Cobbleway Freight (vendor B) in one instruction | allow | - | 1 | core-004 | [slot 524612091](https://explorer.solana.com/tx/2zhSY9RWb9rwFM6aP4oGZU2yg1kMoFpaFxbLW1Y7oQQ3VrhG8Z2oRzG5dHonvgWsH5uFDUX7fHrKbYCpkjFGgpRt?cluster=devnet) |
| 5 | 3.00 USDC to Cobbleway Freight (vendor B) | needs_approval, then allow with approval | `APPROVAL_REQUIRED` | 0, then 1 | core-005, core-016 | [slot 524612102](https://explorer.solana.com/tx/2DizYEgJhfXFv8TXinWWGeQxzA9B7P3UsaEpsJHpr4d1V97guQuo7utcCj7hqLDL793eZc9cKbXASRdaKU9Gw3jb?cluster=devnet) |
| 6 | A new message for 4.50 USDC to Cobbleway Freight (vendor B), presented with scene 5's approval | needs_approval | `APPROVAL_MESSAGE_MISMATCH` | 0 | core-019 | not sent |
| 7 | 1.00 USDC into the outsider's USDC account that is not an associated token account | deny | `RECIPIENT_NOT_ALLOWED` at `ix[0]`, `DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT` at `ix[0]` | 0 | core-052 | not sent |
| 8 | Three transfers of 2.00 USDC in one transaction (cap 5.00) | deny | `PER_TRANSACTION_LIMIT_EXCEEDED` | 0 | core-060 | not sent |
| 9 | A batch with 0.50 USDC to Thistledown Print (vendor A) plus an Approve that makes the outsider a delegate for 1,000 USDC | deny | `TOKEN_INSTRUCTION_NOT_ALLOWED` at `ix[0].batch[1]` | 0 | core-030 | not sent |
| 10 | 1.00 USDC to Thistledown Print (vendor A) using the durable nonce | deny | `DURABLE_NONCE_NOT_ALLOWED` at `ix[0]` | 0 | core-028 | not sent |
| 11 | v1 transfer with a 0.005 SOL priority fee in transactionConfig, plus a no-op SetComputeUnitPrice of 1 micro-lamport | deny | `COMPUTE_BUDGET_INSTRUCTION_IN_V1` at `ix[1]`, `FEE_CAP_EXCEEDED` | 0 | core-037 | not sent |
| 12 | x402: the agent buys one report from Lantern Row (report shop) for 0.02 USDC | allow | - | 1 | x402-001, x402-002 | [slot 524612135](https://explorer.solana.com/tx/3AgTsRYj5UAYqYVoS86GmY9EnXvaeJn7uRoLjxGv7dkP5MweXwj5viGcSWtagq19Kbg9NBm26BK1wNmWJqYRcMVF?cluster=devnet) |
| 13 | x402: the second shop offers four options, each outside the policy | deny | `X402_PAYTO_NOT_ALLOWED`, `X402_FEE_PAYER_NOT_ALLOWED`, `X402_ASSET_NOT_ALLOWED` | 0 | x402-036, x402-037, x402-035 | not sent |
| 14 | x402: a second report (0.04 USDC spent today), then a third against a 0.05 USDC daily budget | allow, then deny | `X402_BUDGET_EXCEEDED` | 1, then 0 | x402-041 | [slot 524612146](https://explorer.solana.com/tx/549rPqREiN8Wer3vKXioqVS2JCQzQGBNW1xhTAwQiZWPi71AsEBDX7j33YXTg9kioSidh7kBFcHe5R1Ju4bgFGdd?cluster=devnet) |
| 15 | x402, facilitator side: a payment signed with the agent key outside the guard, whose token instruction is ApproveChecked, posted to the facilitator's /verify | invalid | `X402_NOT_TRANSFER_CHECKED` at `ix[2]` | 0 | x402-004 | not sent |

Scene 15 counts the calls of the facilitator's key; every other scene counts the calls of the wrapped Keychain signer.
