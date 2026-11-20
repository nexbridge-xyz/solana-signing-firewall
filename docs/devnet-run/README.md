# Devnet run, 2026-11-20

The recorded run of the demo: scenes 1 to 15 on Solana devnet, from commit
`81dc0300018c7f04cfb7b7fe44d98c11ad64f29e` with no uncommitted changes, between 13:59:24 and
13:59:52 UTC. The signer was Solana Keychain (memory backend), wrapped by Signing Firewall.

All company, vendor and shop names are fictional. In this demo the approver's key sits on the same
machine as the treasury's: one person plays both roles. In real use the approver is a different
person, signing on a different device.

## Files

| File                       | What it holds                                                                                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`run.json`](run.json)     | Every scene and step: outcome, reasons, the reviewed message digest, inner signer calls, and for sent steps the signature and slot; the approval of scene 5; every x402 quote option with its digest; balances before and after. |
| [`scenes.md`](scenes.md)   | The scene table, written by `pnpm demo:record`; scene 13's title and vectors were corrected afterwards (Notes).                                                                                                                  |
| [`setup.json`](setup.json) | What setup created, with the signature of each setup transaction ("setup, not a scene"), and the recycling.                                                                                                                      |
| [`policies/`](policies)    | The exact policy files of the run. Their digests are in `run.json`.                                                                                                                                                              |

## Results

15 scenes; 7 transactions sent (scenes 1 to 5, and the x402 settlements of scenes 12 and 14).
Every blocked scene was refused before the inner signer was called, and none was sent. The two x402
settlements are version-1 transactions.

`pnpm verify-run` fetched each sent transaction from devnet and compared the digest of its message
bytes with the decision recorded before signing:

```
  scene 1, review, sign and send: match (slot 524375232, sha256 f2364288b9c1...)
  scene 2, review, sign and send: match (slot 524375241, sha256 18919d7baacd...)
  scene 3, review, sign and send: match (slot 524375247, sha256 278bb23cb0a1...)
  scene 4, review, sign and send: match (slot 524375252, sha256 b6a57f421178...)
  scene 5, after the approver signs: match (slot 524375259, sha256 28d7864a17bb...)
  scene 12, buy one report: match (slot 524375290, sha256 21a0d2e551e6...)
  scene 14, second report: match (slot 524375303, sha256 130e831b133a...)
7 of 7 on-chain messages match the reviewed bytes
```

For scenes 12 and 14 the facilitator added its own signature as fee payer; the message it settled
is the one the agent's guard reviewed.

The scene table, with reasons, vectors and explorer links, is in [`scenes.md`](scenes.md).

## Policies

| Policy                                                                            | SHA-256 of its canonical JSON                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`demo-payouts`](policies/demo-payouts.json) (scenes 1 to 11)                     | `c1b0b306b00c61eb4f68f7207f7830c3b7736bdc34a8beb5830bd9c36386375f` |
| [`demo-agent`](policies/demo-agent.json) (scenes 12 to 14)                        | `ba8f62e5113d9f5e0356b08e7151be9f5e302fa31d73e2ad51105e113c30ee0c` |
| [`demo-facilitator-verifier`](policies/demo-facilitator-verifier.json) (scene 15) | `6a9d1b4e05017ef9670bc2957e44acd1e1c5e2a4def86ba1917322223ae85dbd` |

## Setup

Signed with the unwrapped setup key, not part of any scene. Devnet USDC (20.00) came from
faucet.circle.com and devnet SOL (1.00) from faucet.solana.com, both requested by a person for the
treasury address; the RPC refused the setup's airdrop requests.

| Slot      | Transaction                                                                                                      |                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 524373727 | USDC token accounts for both vendors and the outsider, and a second outsider USDC account that is not associated | [explorer](https://explorer.solana.com/tx/4MV5TzAdmQCh9agMwwGdq9rvjxpLwZiA13ccfTAJjBgydD4GuSsY9UPeAbsT3wiT8LeTM4QFEBsoKvp2Tr4g1SEA?cluster=devnet) |
| 524373734 | Durable-nonce account with the treasury as authority (scene 10 builds against it; nothing is sent with it)       | [explorer](https://explorer.solana.com/tx/2fAUbzXqPq2MPCbgQjoQBeHKEGdQ5DgQadNAf7HgS8D8bgBzXcXAVmLBs56jszUX1trQxkS3kQJcBchDfowEyMe9?cluster=devnet) |
| 524373740 | Lookup table `FVtxNdpVUmnXoVKg3CuWTL1vvVfCCbcCasjNmPzaSvk1` with five demo addresses                             | [explorer](https://explorer.solana.com/tx/2WFwmBQvcbN3ipDgoTUQCU1VC8yMKTFvE8wdhmmNpgfN6pUU1zPBZg92FseXnLX9jTeq4Dq5piRUJx7ZDPN6bwvr?cluster=devnet) |
| 524373747 | 0.05 SOL from the treasury to the local facilitator's fee payer                                                  | [explorer](https://explorer.solana.com/tx/45jgeJATatdTcgrf61SpqqGECRrq5HtXwG1CrKWxBTa5tnQERHERxbDQJKoGzz6euNAimL78SkTZP8A7Bq3crsbp?cluster=devnet) |
| 524375167 | USDC token accounts for the agent and the shop, before the shop advertised its route                             | [explorer](https://explorer.solana.com/tx/54VkMkRQ6BfXg1fDKLthjKKB1wKwk8pHc17KYmxv84dNb2qKfh6tLHSfZqudozFZfjStbBQR3M58CKyzvcEVFE4o?cluster=devnet) |
| 524375175 | 0.10 USDC from the treasury to the agent                                                                         | [explorer](https://explorer.solana.com/tx/5i2GRDTzvKWYhoDtbiVtSFYYmPwHF1HqcrKDqRZRgvfz8eMXkmpT1bVx4J2gRdRdtJdgbPvF9do8NigXfiCCxc8a?cluster=devnet) |
| 524375470 | After the run: 7.04 USDC from the vendors and the shop back to the treasury (recycling)                          | [explorer](https://explorer.solana.com/tx/4sxZJMFpWLNbdf2kzfY1FFb6JCyM9ZhEo56jv42k7f8uzXemuAtTVVSEju37JUm7dkwd4t4tyK96rEgUpmkQQt7S?cluster=devnet) |

The treasury's own USDC account already existed: the faucet created it when it sent the USDC.

## Balances

| Account                                  | Asset          | Before the scenes | After the scenes |
| ---------------------------------------- | -------------- | ----------------- | ---------------- |
| Treasury                                 | SOL (lamports) | 938,235,200       | 938,200,170      |
| Treasury                                 | USDC           | 19.90             | 12.90            |
| Vendor A (Thistledown Print)             | USDC           | 0.00              | 1.90             |
| Vendor B (Cobbleway Freight)             | USDC           | 0.00              | 5.10             |
| Outsider, associated account             | USDC           | 0.00              | 0.00             |
| Outsider, account that is not associated | USDC           | 0.00              | 0.00             |
| Agent                                    | USDC           | 0.10              | 0.06             |
| Shop (Lantern Row)                       | USDC           | 0.00              | 0.04             |
| Facilitator fee payer                    | SOL (lamports) | 50,000,000        | 49,979,998       |

The treasury paid 7.00 USDC to the vendors and 35,030 lamports in fees; the facilitator paid
20,002 lamports for the two settlements. Setup and the run together used about 0.062 SOL of the
1.00 SOL, 0.05 of which sits in the facilitator's fee payer. After recycling, the treasury holds
19.94 USDC.

## Notes

- The public devnet endpoint answered HTTP 429 several times. During setup, one response came
  while setup was confirming the facilitator's 0.05 SOL transfer; the transfer had landed, and it
  was recorded in `setup.json` afterwards, with a note, from `getSignaturesForAddress`. From then
  on the demo repeats a request that got 429, with backoff, and never repeats an airdrop request
  (`docs/DECISIONS.md`, D37). During the run, five requests got that answer and were sent again,
  seven times in all; `terminal.txt` has a line for each repeat.
- Recheck the run with `pnpm verify-run`. It reads only public chain data and needs no key: it
  checks the cluster's genesis hash, then fetches each sent transaction, compares its message with
  the reviewed bytes and checks that it succeeded.
- Corrected on 2026-11-21, after the run: in `scenes.md`, scene 13 was titled "the second shop
  offers four options, each with one fault" and listed x402-038 among its vectors. Option 4 has
  more than one fault (`docs/DECISIONS.md`, D10), and x402-038 is another case. `run.json` and
  `terminal.txt` keep the title as the run recorded it.
