# Devnet run, 2026-11-21

The recorded run of the demo: scenes 1 to 15 on Solana devnet, from commit
`8d92d862ed5f320b636713cc1ce4cfa86bff2e4d` with no uncommitted changes, between 05:47:10 and
05:47:39 UTC. The signer was Solana Keychain (memory backend), wrapped by Signing Firewall.
After it, `pnpm demo:x402` ran scenes 12 to 15 a second time from the same commit, between
05:48:05 and 05:48:26 UTC, into a record of its own. This run replaces the run of
2026-11-20, which stays in the git history.

All company, vendor and shop names are fictional. In this demo the approver's key sits on the same
machine as the treasury's: one person plays both roles. In real use the approver is a different
person, signing on a different device.

## Files

| File                                     | What it holds                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`run.json`](run.json)                   | Every scene and step: outcome, reasons, the reviewed message digest, inner signer calls, and for sent steps the signature and slot; the approval of scene 5; every x402 quote decision; the balances before and after. |
| [`run-x402.json`](run-x402.json)         | The same for the second run of scenes 12 to 15 (`pnpm demo:x402`).                                                                                                                                                     |
| [`scenes.md`](scenes.md)                 | The scene table, written by `pnpm demo:record`.                                                                                                                                                                        |
| [`setup.json`](setup.json)               | What setup created, with the signature of each setup transaction ("setup, not a scene"), and the recycling, for this run and the one before.                                                                           |
| [`policies/`](policies)                  | The exact policy files of the run. Their digests are in `run.json`.                                                                                                                                                    |
| [`terminal.txt`](terminal.txt)           | The terminal output of `pnpm demo`, then `pnpm verify-run`.                                                                                                                                                            |
| [`terminal-x402.txt`](terminal-x402.txt) | The terminal output of `pnpm demo:x402`, then `pnpm verify-run --x402`.                                                                                                                                                |

## Results

15 scenes; 7 transactions sent (scenes 1 to 5, and the x402 settlements of scenes 12 and 14).
Every blocked scene was refused before the inner signer was called, and none was sent. The two x402
settlements are version-1 transactions. Each scene had the same result, reasons, signer calls and
vectors as `pnpm demo:rehearse`, the rehearsal on a local LiteSVM RPC, from the same commit.

`pnpm verify-run` checked the cluster's genesis hash, fetched each sent transaction from devnet,
compared the digest of its message bytes with the decision recorded before signing, and checked
that the transaction succeeded:

```
  scene 1, review, sign and send: match (slot 524612068, sha256 b1f647d08cc1...)
  scene 2, review, sign and send: match (slot 524612074, sha256 13ce4e876cbc...)
  scene 3, review, sign and send: match (slot 524612080, sha256 863c783e1990...)
  scene 4, review, sign and send: match (slot 524612091, sha256 006b84318002...)
  scene 5, after the approver signs: match (slot 524612102, sha256 8ff6d23f2866...)
  scene 12, buy one report: match (slot 524612135, sha256 547d3efb4b49...)
  scene 14, second report: match (slot 524612146, sha256 fae871135623...)
7 of 7 on-chain messages match the reviewed bytes
```

For scenes 12 and 14 the facilitator added its own signature as fee payer; the message it settled
is the one the agent's guard reviewed.

The second run of scenes 12 to 15 had the same results: two settlements, both version-1
transactions, and `pnpm verify-run --x402` reported:

```
  scene 12, buy one report: match (slot 524612298, sha256 c9811d32644d...)
  scene 14, second report: match (slot 524612305, sha256 fc62fc629246...)
2 of 2 on-chain messages match the reviewed bytes
```

The scene table, with reasons, vectors and explorer links, is in [`scenes.md`](scenes.md).

## Policies

| Policy                                                                            | SHA-256 of its canonical JSON                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`demo-payouts`](policies/demo-payouts.json) (scenes 1 to 11)                     | `c1b0b306b00c61eb4f68f7207f7830c3b7736bdc34a8beb5830bd9c36386375f` |
| [`demo-agent`](policies/demo-agent.json) (scenes 12 to 14)                        | `ba8f62e5113d9f5e0356b08e7151be9f5e302fa31d73e2ad51105e113c30ee0c` |
| [`demo-facilitator-verifier`](policies/demo-facilitator-verifier.json) (scene 15) | `6a9d1b4e05017ef9670bc2957e44acd1e1c5e2a4def86ba1917322223ae85dbd` |

## Setup

Signed with the unwrapped setup key, not part of any scene. For the first setup, on 2026-11-20,
devnet USDC (20.00) came from faucet.circle.com and devnet SOL (1.00) from faucet.solana.com, both
requested by a person for the treasury address; the RPC refused the setup's airdrop requests. On
2026-11-21 every account existed already: setup requested no airdrop and sent only the agent's
top-up.

| Date       | Slot      | Transaction                                                                                                      |                                                                                                                                                    |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-20 | 524373727 | USDC token accounts for both vendors and the outsider, and a second outsider USDC account that is not associated | [explorer](https://explorer.solana.com/tx/4MV5TzAdmQCh9agMwwGdq9rvjxpLwZiA13ccfTAJjBgydD4GuSsY9UPeAbsT3wiT8LeTM4QFEBsoKvp2Tr4g1SEA?cluster=devnet) |
| 2026-11-20 | 524373734 | Durable-nonce account with the treasury as authority (scene 10 builds against it; nothing is sent with it)       | [explorer](https://explorer.solana.com/tx/2fAUbzXqPq2MPCbgQjoQBeHKEGdQ5DgQadNAf7HgS8D8bgBzXcXAVmLBs56jszUX1trQxkS3kQJcBchDfowEyMe9?cluster=devnet) |
| 2026-11-20 | 524373740 | Lookup table `FVtxNdpVUmnXoVKg3CuWTL1vvVfCCbcCasjNmPzaSvk1` with five demo addresses                             | [explorer](https://explorer.solana.com/tx/2WFwmBQvcbN3ipDgoTUQCU1VC8yMKTFvE8wdhmmNpgfN6pUU1zPBZg92FseXnLX9jTeq4Dq5piRUJx7ZDPN6bwvr?cluster=devnet) |
| 2026-11-20 | 524373747 | 0.05 SOL from the treasury to the local facilitator's fee payer                                                  | [explorer](https://explorer.solana.com/tx/45jgeJATatdTcgrf61SpqqGECRrq5HtXwG1CrKWxBTa5tnQERHERxbDQJKoGzz6euNAimL78SkTZP8A7Bq3crsbp?cluster=devnet) |
| 2026-11-20 | 524375167 | USDC token accounts for the agent and the shop, before the shop advertised its route                             | [explorer](https://explorer.solana.com/tx/54VkMkRQ6BfXg1fDKLthjKKB1wKwk8pHc17KYmxv84dNb2qKfh6tLHSfZqudozFZfjStbBQR3M58CKyzvcEVFE4o?cluster=devnet) |
| 2026-11-20 | 524375175 | 0.10 USDC from the treasury to the agent                                                                         | [explorer](https://explorer.solana.com/tx/5i2GRDTzvKWYhoDtbiVtSFYYmPwHF1HqcrKDqRZRgvfz8eMXkmpT1bVx4J2gRdRdtJdgbPvF9do8NigXfiCCxc8a?cluster=devnet) |
| 2026-11-20 | 524375470 | After that run: 7.04 USDC from the vendors and the shop back to the treasury (recycling)                         | [explorer](https://explorer.solana.com/tx/4sxZJMFpWLNbdf2kzfY1FFb6JCyM9ZhEo56jv42k7f8uzXemuAtTVVSEju37JUm7dkwd4t4tyK96rEgUpmkQQt7S?cluster=devnet) |
| 2026-11-21 | 524612023 | 0.04 USDC from the treasury to the agent, which still held 0.06                                                  | [explorer](https://explorer.solana.com/tx/5SFbQCsPt6y6hBEtQzDqCX3vaWTBYMdsaUeyqW6u5LY5GxvFQotiSBpnGVqzKMBc8K9kv7WnGZNrRJxkVNBq6fZn?cluster=devnet) |
| 2026-11-21 | 524612480 | After this run: 7.08 USDC from the vendors and the shop back to the treasury (recycling)                         | [explorer](https://explorer.solana.com/tx/3xAJ5vyjLYpwX39hxvM58sQ9uJBnopKBqwWuEsE2KgXkbD7rf7o8Z7vk61Ue7AWajEFtRDd3zAbzrTVVdXJ7ecba?cluster=devnet) |

The treasury's own USDC account already existed: the faucet created it when it sent the USDC.

## Balances

Before and after scenes 1 to 15 (`run.json`):

| Account                                  | Asset          | Before the scenes | After the scenes |
| ---------------------------------------- | -------------- | ----------------- | ---------------- |
| Treasury                                 | SOL (lamports) | 938,175,170       | 938,140,140      |
| Treasury                                 | USDC           | 19.90             | 12.90            |
| Vendor A (Thistledown Print)             | USDC           | 0.00              | 1.90             |
| Vendor B (Cobbleway Freight)             | USDC           | 0.00              | 5.10             |
| Outsider, associated account             | USDC           | 0.00              | 0.00             |
| Outsider, account that is not associated | USDC           | 0.00              | 0.00             |
| Agent                                    | USDC           | 0.10              | 0.06             |
| Shop (Lantern Row)                       | USDC           | 0.00              | 0.04             |
| Facilitator fee payer                    | SOL (lamports) | 49,979,998        | 49,959,996       |

The treasury paid 7.00 USDC to the vendors and 35,030 lamports in fees; the facilitator paid
20,002 lamports for the two settlements. The second x402 run moved 0.04 USDC from the agent to the
shop, and the facilitator paid another 20,002 lamports. Recycling moved 7.08 USDC back to the
treasury for 20,000 lamports in fees. Afterwards the treasury holds 938,120,140 lamports and 19.98
USDC, the facilitator's fee payer 49,939,994 lamports, and the agent 0.02 USDC. Since the first
setup, about 0.062 SOL of the 1.00 SOL has been used, 0.05 of it sent to the facilitator's fee
payer.

## Notes

- The public devnet endpoint answers HTTP 429 often. During the first setup, on 2026-11-20, one
  response came while setup was confirming the facilitator's 0.05 SOL transfer; the transfer had
  landed, and it was recorded in `setup.json` afterwards, with a note, from
  `getSignaturesForAddress`. Since then the demo repeats a request that got 429, with backoff, and
  never repeats an airdrop request (`docs/DECISIONS.md`, D37). In `pnpm demo` 14 requests got that
  answer and were sent again, 26 times in all; in `pnpm demo:x402` one request was sent again four
  times. `terminal.txt` and `terminal-x402.txt` have a line for each repeat.
- Recheck the run with `pnpm verify-run`, and the second x402 run with `pnpm verify-run --x402`.
  It reads only public chain data and needs no key: it checks the cluster's genesis hash, then
  fetches each sent transaction, compares its message with the reviewed bytes and checks that it
  succeeded.
