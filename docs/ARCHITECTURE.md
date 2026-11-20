# Architecture

Signing Firewall for Solana reads a transaction before a signer signs it, checks it against a
policy, and lets the signer sign only what passes. It is a TypeScript library on `@solana/kit`. The
core makes no network calls: it decides from the message bytes, the policy, a snapshot of account
state and the time.

## Packages

```mermaid
flowchart TB
  subgraph core["packages/signing-firewall (no @x402 dependency)"]
    decode["decode/: version, Kit codec, sanitization, lookup tables, batch parser"]
    evaluate["evaluate/: review() and the decision"]
    approval["approval/: createApproval(), verifyApproval()"]
    load["load/: RPC snapshot loader"]
    signer["signer/: withPolicy()"]
    x402["x402/: quote checks, guard, budget ledger, verifier"]
  end
  glue["packages/signing-firewall-x402: @x402 glue"] --> core
  fixtures["packages/fixtures: vector generator, vectors, runner"] --> core
  examples["examples/: devnet demo, local x402 services"] --> glue
  examples --> core
```

- `packages/signing-firewall` is the library. It depends on Kit, the program client packages and
  `@noble/hashes`, never on `@x402`.
- `packages/signing-firewall-x402` connects the guard and the verifier to `@x402/core` and
  `@x402/svm`: `x402RequirementsFilter`, `GuardedExactSvmScheme`, `withX402Verifier`.
- `packages/fixtures` generates the public test vectors and runs them (docs/FIXTURES.md).
- `examples/` holds the devnet demo (`devnet-payouts`, `x402-agent`, `demo-common`).

## Signing path

```mermaid
flowchart LR
  app[App builds a transaction] --> wrapper["withPolicy() signer"]
  wrapper --> loader[Snapshot loader: RPC]
  loader --> review["review(): decode, check"]
  review --> decision{Decision}
  decision -- allow --> key[Inner signer: Keychain backend]
  decision -- needs_approval --> approval{Approval for these exact bytes?}
  approval -- valid --> key
  approval -- missing or invalid --> refuse[PolicyViolationError, signer not called]
  decision -- deny --> refuse
  key --> check[Each signature verified over the reviewed bytes]
  check --> solana[App sends to Solana]
```

`withPolicy(inner, { policy, loader, approvals })` returns a Kit `TransactionPartialSigner` (and a
valid Keychain `SolanaTransactionSigner`), so it drops into Kit's signing helpers in place of the
inner signer. For every call it:

1. loads a snapshot for each transaction and runs `review()`;
2. for a decision that needs approval, looks up an approval by message digest and verifies it;
3. refuses the whole call, before the inner signer sees anything, if any transaction fails;
4. calls the inner signer once, for all transactions;
5. checks that each result is exactly one signature, by the inner signer, valid over the reviewed
   message bytes (`SIGNATURE_INVALID` otherwise).

## `review()`

```mermaid
flowchart LR
  bytes[Message bytes] --> version[Detect version]
  version --> codec[Kit compiled-message codec]
  codec --> sanitize[Runtime sanitization and version-1 limits]
  sanitize --> resolve[Resolve lookup tables from the snapshot]
  resolve --> classify[Classify each instruction, parse batch entries]
  classify --> checks[Signers, fee payer, lifetime, instruction allow-list, transfers, totals, fees, state]
  checks --> out[ReviewDecision]
```

The decision holds the outcome (`allow`, `needs_approval`, `deny`), every failing reason
(docs/REASON_CODES.md), the message digest (SHA-256 of the message bytes), the policy digest, the
version, fee payer and required signers, the lifetime, each transfer with its path, the totals per
mint, the fee summary, the lookup-table entries used and the snapshot slot. `decisionToJson()`
gives its JSON form for logs and recorded runs.

`review()` never assumes account state. The snapshot maps each address it fetched to an account or
to `null` (fetched and absent); an address it never fetched is missing from the map, and a check
that needs it fails with `ACCOUNT_STATE_MISSING`.

## Snapshot loader

`createRpcSnapshotLoader(rpc)` fetches what `review()` needs in two rounds: first the lookup tables
the message names, then the mint, source and destination of every transfer, with
`minContextSlot` so the second round is not older than the first. Accounts that do not exist are
recorded as `null`. Before its first load for a network it checks the RPC's genesis hash against
the policy's `network` (`assertRpcNetwork()`); `localnet` skips the check. A loader is any object
with `load(messageBytes, { network })`, so a node of your own, or several providers compared, can
replace it.

## Approvals

An approval is a small signed record: the message digest, the policy digest, `issuedAt`,
`expiresAt`, the approver's address and an Ed25519 signature over the canonical JSON of the rest,
prefixed with `solana-signing-firewall.approval/v0\n`. It covers those exact bytes under that exact
policy; a changed amount, a new blockhash or an edited policy needs a new approval.
`createApproval()` takes any Kit message signer, so an approver can sign with a Keychain backend
of their own.

## x402

The guard and the verifier are described in docs/X402.md.

```mermaid
flowchart LR
  quote[Quote from a server] --> qc[Quote checks]
  qc --> bound[Bound signer: review, binding, Memo, budget reservation]
  bound --> key[Agent key]
  key --> fac[Facilitator]
  fac --> ver["verifyX402Payment()"]
  ver -- valid --> inner[Facilitator scheme signs and settles]
  ver -- invalid --> no[Refused, nothing signed]
  inner --> solana[Solana]
```

## Digests

| Digest       | Over                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| message      | SHA-256 of the message bytes (what the signer signs), hex                          |
| policy       | SHA-256 of the RFC 8785 canonical JSON of the policy file as given, hex            |
| requirements | SHA-256 of the RFC 8785 canonical JSON of one x402 payment option as received, hex |

All three are synchronous (`@noble/hashes`), because `x402Client.registerPolicy()` calls the quote
checks synchronously.
