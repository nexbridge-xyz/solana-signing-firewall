# Threat model

Signing Firewall for Solana is a devnet proof of concept. It has not been audited. This document
says what it protects against, what it relies on, and what it does not cover.

## What it protects

A key that signs whatever bytes it is given. Signing Firewall sits in front of that key and refuses
to let it sign a transaction that breaks the policy: a payee, token, amount, fee, program, signer or
lifetime the policy does not allow. For x402 it also refuses payments that do not match the quote
the agent accepted, and lets a facilitator refuse payments that do not match the quote it is asked
to settle.

## Assumptions

- The policy file and the code are what the operator intended. Anyone who can change them controls
  the outcome.
- The inner signer signs only through the wrapper (see "Bypass" below).
- The snapshot loader's RPC tells the truth, or the operator accepts the risk (see "RPC").
- The machine's clock is roughly right (approval expiry, budget windows).

## Bypass through the raw signer

The wrapper protects calls that go through it. It cannot stop code that holds the raw key, or the
credentials of a remote signer, from signing directly. Deployments should make the wrapped signer
the only one the application can reach: keep the key in a backend (a KMS, an HSM, a signing
service) whose credentials only the wrapping process holds, and grant that process nothing else.
This is the main limit of a library that runs in the same process as the application; a signing
service that runs the same checks on its own side, or on-chain limits, close it.

A wrapped signer that the inner backend does not honor is caught: the wrapper takes its own copy
of every transaction before it does anything else, gives the inner signer a second copy, and
verifies every returned signature over its own copy (`SIGNATURE_INVALID`, D41). A signer that would
send or rewrite the transaction itself is refused when the wrapper is created
(`UNSUPPORTED_INNER_SIGNER`). A backend whose `signTransactions` also sends what it signs cannot be
told apart from one that does not; what it sends is what was reviewed only if it does not rewrite
the bytes.

## RPC

`review()` decides from the snapshot the loader fetched. A dishonest or compromised RPC can lie
about account state, for example report that a token account belongs to an allowed vendor when it
belongs to someone else, or hide that an account is frozen. Mitigations:

- The loader checks the RPC's genesis hash against the policy's network, so a devnet policy is not
  checked against another cluster.
- Every decision records the snapshot slot (0 when the loader fetched nothing), so a recorded
  decision can be compared with the chain afterwards (`pnpm verify-run` does this for the message bytes).
- Your own node, or several providers compared, is the real mitigation. A loader is a small
  interface; a multi-provider loader is on the roadmap.

The associated-token-account rule limits the damage for a destination the message names itself:
by default a destination must be the allowed owner's associated token account, an address derived
from the owner and the mint, so the RPC cannot pass off another account as an allowed owner's
without the derivation failing.

The rule does not cover an account that a version-0 message loads from a lookup table. Such a
message holds only the table's address and an index. `review()` learns the address behind the
index from the snapshot, which is to say from the same RPC, and the rule then checks that
address. An RPC that reports false table contents makes `review()` check one destination while
the runtime, which reads the real table, pays another
(`packages/fixtures/test/review-lookup-table-rpc.test.ts` shows it in LiteSVM, with an honest
application that compressed its message from what the RPC told it). Each signature given this
way loses at most the mint's `maxPerTransaction`; v0.1.0 has no limit across transactions outside
x402. Unless the RPC is a node of your own, leave `v0` out of `messageVersions`, or send
version-0 messages that use no lookup table. x402 payments already refuse lookup tables. A policy
that pins the tables it accepts together with their entries would close this; v0.1.0 has none.

## The cluster

Nothing in the signed bytes names a cluster. `review()` does not look at the blockhash, and in x402
the quote can supply it (`extra.recentBlockhash`). A signature is valid on any cluster where the
same accounts exist, so use a key on one cluster only. The loader's genesis-hash check makes sure
the snapshot comes from the policy's network; it does not bind the signature to that network.

## State that changes between review and execution

The snapshot is a moment. Between review and execution, accounts can change: a token account can
be closed, frozen or emptied, a lookup table can be extended or deactivated, an account can be
reassigned. What this means here:

- Transfers name their destination token accounts explicitly. If one is closed and recreated with
  another owner, the associated-token-account rule still ties the address to the allowed owner.
- Lookup-table entries cannot change once written; a table can only grow, be frozen or be
  deactivated. Entries are resolved at the snapshot slot, entries not yet active are refused, and
  a deactivating table is refused even though it still resolves on chain for a while.
- A transfer can still fail on chain (for example a frozen account). Failing is safe; doing
  something else is not possible, because the message bytes cannot change after signing.

## Durable nonces

A durable-nonce transaction does not expire with a recent blockhash: it stays valid until the nonce
is advanced. A signature over it is a standing authorization that anyone holding the bytes can
submit later. v0.1.0 refuses every durable-nonce transaction (`DURABLE_NONCE_NOT_ALLOWED`).

Solana plans to replace durable nonces with on-chain offline-signer programs (the solana.com
upgrade page "Durable Nonce Deprecation", 2026-10-06, in development). Signatures for those programs
carry no blockhash and stay valid until used or cancelled, which is the same risk in a new form.
Rules that look for the nonce-advance instruction will not see them. Signing Firewall refuses every
program it does not know (`PROGRAM_NOT_ALLOWED`), so such programs are refused until a policy
explicitly supports them; core-029 shows this with a clearly labelled placeholder program. It does
not reproduce the real programs' addresses or message formats.

## Blockhash lifetime and approval time

A transaction with a recent blockhash is valid for about 60 to 90 seconds. An approval names the
message digest, so it covers one blockhash: if the transaction expires before it is sent, the new
transaction has a new digest and needs a new approval. The policy's `ttlSeconds` caps how long an
approval can be valid (the demo uses 90 seconds). The approval and the blockhash expire
independently; the earlier one wins.

An approval is checked when the wrapper signs. Revoking an approval after that is not possible: the
signature exists.

## Simulation is not authorization

A simulation shows what a transaction would do against the state the RPC has now. It does not say
whether the signer should allow it, it can be fooled by state that changes, and a malicious program
can behave differently when simulated. Signing Firewall does not simulate. It decides from what the
bytes say: which programs, which instructions, which accounts, which amounts. That is why it refuses
unknown programs instead of trying to predict them.

## x402

### A hostile seller

A server can quote any payee, asset, amount, fee payer or timeout, and can offer several options at
once. The quote checks refuse options outside the policy before anything is signed (scene 13), and
the bound signer checks that the bytes pay the chosen quote and nothing else. A seller that names
the agent itself as fee payer is refused (`X402_FEE_PAYER_NOT_ALLOWED`): the agent would pay the
network fee and its SOL could be drained.

A seller on the policy's list can still choose the Memo the agent signs: `extra.memo`, up to 256
bytes of any text (see "A faulty or compromised payment SDK" below). Treat a Memo signed by an
agent key as chosen by the seller, never as a statement by the agent.

### A faulty or compromised payment SDK

The SDK builds the transaction the agent signs. A bug or a replaced package could build a different
payment than the quote. The bound signer reviews the bytes against the quote: one `TransferChecked`
of the quoted asset and amount into the payee's associated token account, the quoted fee payer, an
accepted layout, the price cap. A payment that approves a delegate instead of transferring
(`ApproveChecked`) is refused.

What remains: the Memo, and the quote itself. The guard learns the quote from the SDK, so an
altered SDK can present any quote the policy allows: any listed payee and asset, any amount up to
the per-payment cap. The policy, the daily budget and the rate limit bound that; nothing ties the
quote the guard checks to what the seller really sent.

For the Memo the guard accepts two forms. Without `extra.memo` it requires exactly 32 lower-case
hex characters, the form the pinned SDK builds; an altered SDK can still choose those 16 bytes.
With `extra.memo` it requires exactly that text, up to 256 bytes of any valid UTF-8, control
characters and invisible characters included. The seller chooses that text; and because the quote
comes through the SDK, an altered SDK can add an `extra.memo` of its own to any quote. Either can
so make the agent's key sign up to 256 bytes of its choosing in each payment, including text that
reads like a statement or an approval (`packages/signing-firewall/test/review-x402-memo.test.ts`).
The policy's `memo.maxBytes` lowers that bound (32 still admits the SDK's own nonce and refuses
longer seller memos); v0.1.0 has no switch that refuses seller memos or limits their characters.
The rate limit and the daily budget bound how many payments, and so how many bytes, that is.

Use 2.23.0 or later of the `@x402` TypeScript packages. V12's x402 disclosure (2026-10-22) reported,
among 25 findings, a facilitator that accepted `ApproveChecked` as a payment and a client with no
default spending cap. The facilitator check first shipped in `@x402/svm` 2.23.0; TypeScript clients
get the default cap from `@x402/fetch` or `@x402/axios` 2.23.0, which pull in the matching
`@x402/core`.

### A prompt-injected agent that keeps paying

An agent that reads hostile content may try to pay again and again, or pay someone new. The guard
does not depend on the agent's judgement: the payee must be in the policy, each payment is capped,
the daily budget is per mint over a rolling 24 hours, and the rate limit counts payments over 60
seconds. A budget reservation is made before the key is called and is never released, even when the
payment does not land, so a failure cannot be used to spend twice. A reservation dated after now,
as after a step back of the clock, still counts (D43).

### A buyer who attacks the facilitator

A facilitator signs as fee payer and submits the transaction. A buyer can send a payment that moves
nothing (an `ApproveChecked`, a transfer to the wrong account, a smaller amount, a transfer out of
the payee's own account into itself, made as its delegate), one that makes the fee payer pay for
something else or move its own funds (as the transfer authority, as the delegate of a fee payer's
token account, or through another fee payer of the same facilitator), one with a forged buyer
signature, or one that uses a durable nonce. The verifier requires the source to be the buyer's
associated token account for the asset and keeps every fee payer of its config out of every
instruction (D54). `withX402Verifier()` runs `verifyX402Payment()` before the facilitator scheme
is called at all, so a refused payment is neither signed nor simulated (scene 15).

### What v0.1.0 does not do for x402

- **No human approval.** A payment above `approvalAbove` is refused (`APPROVAL_REQUIRED`); v0.1.0
  has no way for a person to approve an x402 payment, because a payment never waits (D25).
- **No Token-2022.** The guard and the verifier both refuse Token-2022 payments
  (`TOKEN_PROGRAM_NOT_ALLOWED`, D26).
- **One process per budget file.** The file ledger is for one Node.js process, and anyone who can
  edit the file can reset the budget (D27, below).
- **The source is checked by its address.** The guard and the verifier require the source to be
  the payer's associated token account for the asset, and they derive that address from the payer
  and the asset alone (D54). An SPL Token account's owner can be changed after the account is
  created, so the account at that address could by then belong to the fee payer. A transfer from
  it still needs the payer to be its delegate, and only the fee payer can grant that, by signing an
  `Approve` itself. Comparing the source's owner in the snapshot with the payer would close this;
  that check is later work.

### A budget file anyone on the machine can reset

The file ledger is a JSON file. Anyone who can write to it, or delete it, can reset the budget. It
is a guard against a misbehaving agent, not against someone with access to the machine. A budget
kept by a separate signing service, or on chain, is out of scope for v0.1.0.

## Not covered

- Token-2022 and its extensions (transfer hooks, fees, confidential transfers): refused, not
  analysed.
- Multisig authorities: refused.
- Any program other than SPL Token, ComputeBudget and SPL Memo: refused, not analysed.
- Smart-contract wallets and account abstraction.
- Limits across transactions for the core policy (daily limits outside x402).
- Ordering, front-running and MEV.
- The safety of the inner signer's backend itself.
- The demo's own keys: they are throwaway devnet keys kept in a local `.env`. In the demo the
  approver's key sits on the same machine as the treasury's, so one person plays both roles; an
  approval protects anything only when the approver is a different person on a different device.

## Status

A devnet proof of concept. Not audited. Not for mainnet funds.
