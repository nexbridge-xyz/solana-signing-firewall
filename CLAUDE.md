# CLAUDE.md

Development notes for Signing Firewall for Solana.

**If `docs/DECISIONS.md` conflicts with any other development instructions, `docs/DECISIONS.md`
takes precedence.**

## Layout

- `packages/signing-firewall`: the library. It must not depend on `@x402`.
- `packages/signing-firewall-x402`: glue to the `@x402` packages.
- `packages/fixtures`: the vector generator, the committed vectors and the runner.
- `docs/`: design documents. `docs/DECISIONS.md` records decisions with their reasons.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test
pnpm fixtures:generate   # rewrite packages/fixtures/vectors/core
pnpm fixtures:check      # fail if the committed vectors differ from the generator
pnpm fixtures            # run every vector
```

## Rules

- English only in the repository and in terminal output.
- Devnet and local only. No request of any kind to mainnet.
- Keys live only in `.env`, which git ignores. Never print or log them. Fixture keys come from
  public seeds: never fund them and never use them on a network.
- Never drive a faucet from code.
- Take program addresses from the program client packages; never type them by hand.
- Pin exact dependency versions and commit the lockfile.
- Small commits in Conventional Commits format.
- Do not describe this project as "audited", "certified", "first" or "only".
- x402: if any third-party implementation turns out to accept a payment the spec forbids, or to
  move value it should not, stop that line of work. Commit nothing about it (no vector, result or
  description), open no issue or pull request, and report it privately to the maintainers.
