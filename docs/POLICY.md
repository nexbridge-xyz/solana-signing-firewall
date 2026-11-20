# Policy file

A policy says which transactions one signer may sign. `parsePolicy()` is the schema: it rejects
unknown fields, checks every value, and fills each switch the file leaves out with its strict
value. `docs/DECISIONS.md` (D16) records why there is no separate JSON Schema file in v0.1.0.

The policy digest is SHA-256 over the RFC 8785 canonical JSON of the file as given, not over the
filled-in form (`policyDigest()`). Approvals name this digest, so changing a policy file voids
every approval issued under it.

## Example

The payouts policy of the devnet demo (`docs/devnet-run/policies/demo-payouts.json` after a run):

```json
{
  "schema": "solana-signing-firewall.policy/v0",
  "policyId": "demo-payouts",
  "network": "devnet",
  "signer": "<treasury address>",
  "feePayers": ["<treasury address>"],
  "messageVersions": ["legacy", "v0", "v1"],
  "durableNonce": "deny",
  "tokenBatch": "transfers-only",
  "mints": {
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
      "decimals": 6,
      "maxPerTransaction": "5000000",
      "approvalAbove": "2000000"
    }
  },
  "sources": ["<treasury USDC associated token account>"],
  "recipients": {
    "owners": ["<vendor A>", "<vendor B>"],
    "requireAssociatedTokenAccount": true
  },
  "fees": {
    "maxComputeUnitLimit": 200000,
    "maxPriorityFeeLamports": "50000",
    "requireExplicitComputeUnitLimit": true
  },
  "approval": { "approvers": ["<approver>"], "ttlSeconds": 90 }
}
```

## Fields

Amounts are decimal strings of base units within u64 (`"5000000"` is 5.00 of a 6-decimal token).
Addresses are base58. Lists of addresses must be non-empty and free of duplicates.

| Field                                      | Required | Values                                                                         | Meaning                                                                                                                              |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`                                   | yes      | `solana-signing-firewall.policy/v0`                                            | Format version.                                                                                                                      |
| `policyId`                                 | yes      | non-empty string                                                               | A name for logs and approvals.                                                                                                       |
| `network`                                  | yes      | `devnet`, `testnet`, `mainnet`, `localnet`                                     | The RPC loader refuses an RPC whose genesis hash belongs to another cluster. `localnet` skips the check (LiteSVM, local validators). |
| `signer`                                   | yes      | address                                                                        | The key this policy guards. Every transfer authority must be this signer, and it must sign the message.                              |
| `feePayers`                                | yes      | addresses                                                                      | Who may pay the fee.                                                                                                                 |
| `messageVersions`                          | yes      | any of `legacy`, `v0`, `v1`                                                    | Message versions the signer may sign.                                                                                                |
| `durableNonce`                             | no       | `deny` (default)                                                               | v0.1.0 refuses every durable-nonce transaction.                                                                                      |
| `tokenBatch`                               | no       | `deny` (default), `transfers-only`                                             | P-Token `batch`: refused, or allowed when every entry is an allowed `TransferChecked`.                                               |
| `mints`                                    | yes      | map of mint address to rule                                                    | The tokens that may move. At least one.                                                                                              |
| `mints.<mint>.decimals`                    | yes      | 0 to 255                                                                       | Must match the mint account and the instruction.                                                                                     |
| `mints.<mint>.maxPerTransaction`           | yes      | amount                                                                         | Cap on the sum of all transfers of this mint in one transaction.                                                                     |
| `mints.<mint>.approvalAbove`               | no       | amount                                                                         | A total above this needs an approval. Requires `approval`.                                                                           |
| `sources`                                  | yes      | addresses                                                                      | Token accounts the signer may pay from.                                                                                              |
| `recipients.owners`                        | yes      | addresses                                                                      | Owners whose token accounts may receive.                                                                                             |
| `recipients.requireAssociatedTokenAccount` | no       | `true` (default), `false`                                                      | The destination must be the owner's associated token account for the mint.                                                           |
| `fees.maxComputeUnitLimit`                 | yes      | 1 to 1,400,000                                                                 | Highest compute-unit limit a message may set.                                                                                        |
| `fees.maxPriorityFeeLamports`              | yes      | amount                                                                         | Cap on the total priority fee in lamports.                                                                                           |
| `fees.requireExplicitComputeUnitLimit`     | no       | `true` (default), `false`                                                      | The message must set its compute-unit limit.                                                                                         |
| `memo`                                     | no       | `{ "allowed": false }` (default) or `{ "allowed": true, "maxBytes": 1..1024 }` | SPL Memo instructions.                                                                                                               |
| `approval`                                 | no       | `{ "approvers": [...], "ttlSeconds": 1..86400 }`                               | Who may approve, and the longest validity of an approval.                                                                            |
| `x402`                                     | no       | see below                                                                      | Turns on the x402 guard for this signer.                                                                                             |

### Fees

Legacy and v0 messages carry their fee settings in ComputeBudget instructions; the priority fee
is `ceil(limit × price / 1,000,000)` lamports, using 1,400,000 units when the message sets no
limit. Version-1 messages carry them in `transactionConfig`, where the priority fee is already a
total; ComputeBudget instructions in a version-1 message are no-ops on chain and are refused
(`COMPUTE_BUDGET_INSTRUCTION_IN_V1`). Only one `SetComputeUnitLimit` and one
`SetComputeUnitPrice` are allowed, and no other ComputeBudget instruction.

### The `x402` block

| Field                              | Required | Values                                                            | Meaning                                                                  |
| ---------------------------------- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `networks`                         | yes      | CAIP-2 IDs, for example `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | Networks the agent may pay on.                                           |
| `schemes`                          | no       | `["exact"]` (default)                                             | Payment schemes. Only `exact` exists in v0.1.0.                          |
| `maxTimeoutSeconds`                | yes      | 1 to 3600                                                         | Longest `maxTimeoutSeconds` a quote may ask for.                         |
| `maxComputeUnitPriceMicroLamports` | yes      | amount                                                            | Highest compute-unit price in a payment.                                 |
| `createRecipientAccount`           | no       | `deny` (default)                                                  | A payment never creates the seller's token account.                      |
| `lookupTables`                     | no       | `deny` (default)                                                  | A payment never uses lookup tables.                                      |
| `budgets`                          | yes      | map of mint to `{ "maxPerDay": amount }`                          | Rolling 24-hour budget per mint. A mint without a budget cannot be paid. |
| `maxPaymentsPerMinute`             | yes      | 1 to 600                                                          | Payments across all mints in any 60 seconds.                             |

x402 payments also obey the rest of the policy: `mints` (per-payment cap through
`maxPerTransaction`), `sources`, `recipients` (the sellers), `feePayers` (the facilitators),
`messageVersions` and `fees`. An amount above `approvalAbove` is refused, because an x402 payment
never waits for a person. `docs/X402.md` describes the checks.

## Errors

`parsePolicy()` throws `PolicyError` with the path of the first bad field, for example
`policy.mints.<mint>.approvalAbove: needs an "approval" section`.
