Recorded on devnet, 2026-11-20T13:59:24.695Z, from commit 81dc0300018c. Signer: Solana Keychain (memory backend), wrapped by Signing Firewall.

| # | Scene | Result | Reasons | Inner signer calls | Vectors | Transaction |
|---|---|---|---|---|---|---|
| 1 | Legacy transfer: 1.00 USDC to Thistledown Print (vendor A) | allow | - | 1 | core-001 | [slot 524375232](https://explorer.solana.com/tx/3ahhXcUaTqBU3QK6gDAbnDp9TYcaHSQBUbjYe2dN4dhLksBD7VbS5gxBCoU4JCPmJQffFrgswiHEY6AMsnys9jeX?cluster=devnet) |
| 2 | v0 transfer through the lookup table: 1.50 USDC to Cobbleway Freight (vendor B) | allow | - | 1 | core-002 | [slot 524375241](https://explorer.solana.com/tx/L8sd4nHz9KvASakaQmiUrxU5ojyHntCnfFAJ8PgPVKDuwFacQ5MpCJGXPvbmMa9oyYAxi5qpRKwpjFgMAyeGFF1?cluster=devnet) |
| 3 | v1 transfer: 0.50 USDC to Thistledown Print (vendor A), priority fee within the cap | allow | - | 1 | core-003 | [slot 524375247](https://explorer.solana.com/tx/3NKBhAJBEHjsecX82nCrZpap1FUB4gsMXFQxAAGqsvc1CT4m7VdZGtJyG591zYLYFSes6kWKvE6KARUvTGqLRGnJ?cluster=devnet) |
| 4 | P-Token batch: 0.40 USDC to Thistledown Print (vendor A) and 0.60 USDC to Cobbleway Freight (vendor B) in one instruction | allow | - | 1 | core-004 | [slot 524375252](https://explorer.solana.com/tx/5pYsBboAsCby6FtUydxLhvM4mA4xEAuiYVadRG8hP5Vf7AmLLZesxMxTkmDhUWKyjAcu7bYoN5KcVqocnRgwejcf?cluster=devnet) |
| 5 | 3.00 USDC to Cobbleway Freight (vendor B) | needs_approval, then allow with approval | `APPROVAL_REQUIRED` | 0, then 1 | core-005, core-016 | [slot 524375259](https://explorer.solana.com/tx/3BwLLDQS4LK65BWn6r27Rszp3NcfUNDmUtRYMHbG3qut8N3Yw7PUi1TsWSLPqkdQ3gnHZyrzmfSh5az9aB85kbuY?cluster=devnet) |
| 6 | A new message for 4.50 USDC to Cobbleway Freight (vendor B), presented with scene 5's approval | needs_approval | `APPROVAL_MESSAGE_MISMATCH` | 0 | core-019 | not sent |
| 7 | 1.00 USDC into the outsider's USDC account that is not an associated token account | deny | `RECIPIENT_NOT_ALLOWED` at `ix[0]`, `DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT` at `ix[0]` | 0 | core-052 | not sent |
| 8 | Three transfers of 2.00 USDC in one transaction (cap 5.00) | deny | `PER_TRANSACTION_LIMIT_EXCEEDED` | 0 | core-060 | not sent |
| 9 | A batch with 0.50 USDC to Thistledown Print (vendor A) plus an Approve that makes the outsider a delegate for 1,000 USDC | deny | `TOKEN_INSTRUCTION_NOT_ALLOWED` at `ix[0].batch[1]` | 0 | core-030 | not sent |
| 10 | 1.00 USDC to Thistledown Print (vendor A) using the durable nonce | deny | `DURABLE_NONCE_NOT_ALLOWED` at `ix[0]` | 0 | core-028 | not sent |
| 11 | v1 transfer with a 0.005 SOL priority fee in transactionConfig, plus a no-op SetComputeUnitPrice of 1 micro-lamport | deny | `COMPUTE_BUDGET_INSTRUCTION_IN_V1` at `ix[1]`, `FEE_CAP_EXCEEDED` | 0 | core-037 | not sent |
| 12 | x402: the agent buys one report from Lantern Row (report shop) for 0.02 USDC | allow | - | 1 | x402-001, x402-002 | [slot 524375290](https://explorer.solana.com/tx/4qVJW9UkZvnk7Zd7C2hjL3JijJjyG9LsF8UFv5VK8sPYdnwi6odaPcQk4AHpbyihDs7LHprfcWV9S2eBtdxrEeDf?cluster=devnet) |
| 13 | x402: the second shop offers four options, each outside the policy | deny | `X402_PAYTO_NOT_ALLOWED`, `X402_FEE_PAYER_NOT_ALLOWED`, `X402_ASSET_NOT_ALLOWED` | 0 | x402-036, x402-037, x402-035 | not sent |
| 14 | x402: a second report (0.04 USDC spent today), then a third against a 0.05 USDC daily budget | allow, then deny | `X402_BUDGET_EXCEEDED` | 1, then 0 | x402-041 | [slot 524375303](https://explorer.solana.com/tx/5bcNRTvdzDcGuCWuUK9FV5k26tGPAoTdhxwiRuoLqNy3urisqF1xAebCx2aw3PHJxniTHJ7vGcJ8W2V1Q3Fkx7Pq?cluster=devnet) |
| 15 | x402, facilitator side: a payment signed with the agent key outside the guard, whose token instruction is ApproveChecked, posted to the facilitator's /verify | invalid | `X402_NOT_TRANSFER_CHECKED` at `ix[2]` | 0 | x402-004 | not sent |

Scene 15 counts the calls of the facilitator's key; every other scene counts the calls of the wrapped Keychain signer.
