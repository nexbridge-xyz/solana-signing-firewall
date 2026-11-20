# Security

Signing Firewall for Solana is a devnet proof of concept. It has not been audited. Do not use it to
protect mainnet funds.

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability reporting for this
repository ("Report a vulnerability" on the Security tab). Do not open a public issue or pull
request for a vulnerability.

Include what you found, how to reproduce it (a vector in the format of `docs/FIXTURES.md` is ideal),
and what an attacker gains. We will acknowledge the report, agree on a fix and a disclosure date
with you, and credit you if you wish.

## Scope

In scope: `packages/signing-firewall`, `packages/signing-firewall-x402` and the vectors in
`packages/fixtures`, for example a transaction the policy forbids that `review()` allows, a payment
that does not match its quote that the guard or the verifier accepts, a way to make the wrapper sign
without a review, or a crash on crafted input.

Out of scope: the example applications' own keys and servers (they are throwaway devnet setups on
`127.0.0.1`), and the limits listed under "Not covered" in `docs/THREAT_MODEL.md`.

## Problems in other projects

If you find that another x402 implementation, a Keychain backend or another dependency accepts a
payment the spec forbids, or would move value it should not, report it privately to that project's
maintainers first. Please do not publish a vector or a description of it here before they have
had the chance to fix it.
