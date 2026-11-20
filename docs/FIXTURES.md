# Test vectors

The vectors are public test data for anyone who checks Solana transactions before signing them:
wallets, signers, and x402 clients and facilitators. Each one is a JSON file with the exact bytes,
the policy, the account state and the expected answer, so another implementation can run them
without our code.

```sh
pnpm fixtures            # run every vector against this implementation
pnpm fixtures:generate   # rewrite the vectors from packages/fixtures/src
pnpm fixtures:check      # fail if the committed vectors differ from the generator
```

The generator is deterministic: keys come from fixed public seeds
(`sha256("solana-signing-firewall/fixtures/v0/" + label)`), the blockhash is fixed, and the
payments built by the x402 SDK use a seeded nonce. **These keys are public. Never fund them and
never use them on a network.** The USDC mint is Circle's devnet mint, so the vectors line up with
the devnet demo; the vectors themselves never touch a network.

IDs are stable. New vectors get new numbers; a vector is never renumbered or reused.

## Layout

```
packages/fixtures/vectors/
  core/core-001.json ... core-069.json   transaction review
  core/policies/*.json                   policies the core vectors name
  x402/x402-001.json ... x402-045.json   x402 payments, client and facilitator side
  x402/policies/fixtures-agent.json      the agent policy
  x402/verifier/fixtures-facilitator.json  the facilitator's verifier config
```

## Snapshots

A snapshot is the account state an evaluation may read, fetched at one slot:

```json
{
  "slot": "1000",
  "accounts": {
    "<address>": {
      "owner": "<program>",
      "lamports": "2039280",
      "data": "<base64>",
      "executable": false
    },
    "<address>": null
  }
}
```

`null` means the account was fetched and does not exist. An address missing from `accounts` was
never fetched. The two are different answers: a missing destination is
`DESTINATION_ACCOUNT_MISSING`, while state the evaluation needs but never received is
`ACCOUNT_STATE_MISSING`. An implementation must not assume anything about accounts it was not
given.

## Core vectors

| Field                     | Meaning                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `title`, `category` | Stable ID, a one-line description, and a group (`allow`, `malformed`, `approval`, `fees`, ...).                                                            |
| `messageVersion`          | From the first message byte: `legacy`, `v0`, `v1`, `unsupported`, or `none` for empty bytes.                                                               |
| `message`                 | The message bytes, the bytes a signer signs, base64. Not a wire transaction.                                                                               |
| `policy`                  | The policy file, relative to `vectors/core/` (format: `docs/POLICY.md`).                                                                                   |
| `snapshot`                | The account state, as above.                                                                                                                               |
| `now`                     | The time of the evaluation (approval expiry).                                                                                                              |
| `approval`                | An approval record presented with the message, if any.                                                                                                     |
| `expect.outcome`          | `allow`, `needs_approval` or `deny`.                                                                                                                       |
| `expect.reasons`          | The reason codes, as a set: order and duplicates do not matter.                                                                                            |
| `expect.approval.reasons` | The approval check's codes; empty means the approval is valid.                                                                                             |
| `expect.decoded`          | For some vectors, facts any decoder must agree on: version, fee payer, required signers, lifetime, instructions, transfers, fees and lookup-table entries. |
| `runtimeVerdict`          | What the Solana runtime does with the message, signed by its required signers, against the snapshot: `runtime_accepts` or `runtime_rejects`.               |
| `runtimeCheckedBy`        | `litesvm` when a test sends the vector to LiteSVM and confirms the verdict; `not_checked` otherwise, with a note.                                          |
| `notes`                   | Why a vector is the way it is, where that is not obvious.                                                                                                  |

A `deny` vector marked `runtime_accepts` is a check stricter than the runtime: the transaction
would execute, and we refuse to sign it. Most deny vectors are like that; that is the point of
checking before signing. For each vector `review()` allows, the LiteSVM test also checks that the
token balances change by exactly the reviewed transfers.

LiteSVM 1.6.2 aborts the whole process on bytes it cannot deserialize, so those vectors are
`not_checked`, as are vectors whose program LiteSVM does not load and vectors whose snapshot leaves
state out on purpose (D20).

To pass a core vector, an implementation decodes `message`, evaluates it under `policy` against
`snapshot` at `now`, and returns the expected outcome and the same set of codes; when `approval`
is present, it also verifies the approval and returns the same set of approval codes.

## x402 vectors

| Field                | Meaning                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `title`        | Stable ID and description.                                                                                                                                               |
| `specRules`          | Sections of the official `scheme_exact_svm.md` (x402-foundation/x402, commit `4f64aba41`) the vector exercises.                                                          |
| `specVerdict`        | What the spec requires, independent of our codes (below).                                                                                                                |
| `requirements`       | One payment option, as a server sends it in `PAYMENT-REQUIRED`.                                                                                                          |
| `transaction`        | The partially signed wire transaction, base64, as a client sends it. Absent when the vector is about the quote alone.                                                    |
| `policy`             | The agent policy, relative to `vectors/x402/`. Present when `expect.client` is.                                                                                          |
| `verifierConfig`     | The facilitator's verifier config. Present when `expect.facilitator` is.                                                                                                 |
| `snapshot`, `now`    | Account state and time.                                                                                                                                                  |
| `ledger`             | Reservations already in the agent's budget (for the budget and rate-limit vectors).                                                                                      |
| `expect.client`      | The agent-side guard: `allow` or `deny` with codes. For vectors without `transaction`, the quote checks alone; otherwise the full review of the bytes against the quote. |
| `expect.facilitator` | The facilitator-side verifier: `valid` or `invalid` with codes.                                                                                                          |

Vectors aimed at a facilitator (a fee payer used as the payer, a forged buyer signature) carry
only `expect.facilitator`: no honest agent would build them.

### `specVerdict`

| Value                | Meaning                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `must_accept`        | Meets every MUST of the spec.                                                                                      |
| `must_reject`        | Breaks a MUST of the spec, so a compliant facilitator refuses it.                                                  |
| `stricter_than_spec` | Meets the spec, but our guard or verifier refuses it. Another implementation may accept it and still be compliant. |

The three payments built by the pinned `@x402/svm` 2.31.0 client (x402-001 to x402-003: version 0,
version 1, and version 1 with a seller memo) are `must_accept`, and both our guard and our verifier
accept them. If the SDK's output and the spec ever disagree, that is reported to the maintainers
first (CONTRIBUTING.md).

Where we are stricter than the spec, and why, is in `docs/X402.md` and `docs/DECISIONS.md`
(D7 to D9).

## Open questions in the x402 spec

The verifier enforces only what the spec states. These points are open in
`scheme_exact_svm.md` at commit `4f64aba41`; the vectors pin our current reading and the verifier
does not enforce more:

1. **Letter case of the memo nonce.** The spec asks for a hex-encoded nonce of at least 16 random
   bytes. It does not say whether upper-case hex is allowed. The verifier accepts either case
   (x402-028 is `valid` for the facilitator); the guard accepts only the lower-case form the
   pinned SDK builds.
2. **Odd length.** A hex string of odd length does not encode whole bytes. The spec does not say
   whether such a nonce is valid. The verifier accepts any hex string of at least 32 characters.
3. **Upper bound.** The spec gives a lower bound (16 bytes) and no upper bound for the nonce. The
   verifier sets none (x402-027, 32 bytes, is `valid` for the facilitator); the guard requires
   exactly 32 characters.
4. **Extra Memos.** Without a seller memo, the spec does not say what other Memo instructions may
   contain. The verifier accepts extra Memos after the transfer (x402-024); the guard refuses them.
5. **A Memo with accounts.** The spec does not say whether the Memo may list accounts. The
   verifier accepts it (x402-030); the guard refuses it, because a Memo that lists the buyer asks
   for the buyer's signature over it.
