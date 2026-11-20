# Contributing

## Setup

Node.js 22 and pnpm 12 (`corepack enable`), then:

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                 # unit, property and LiteSVM tests; offline
pnpm fixtures:check       # the committed vectors match the generator
pnpm fixtures             # run every vector
pnpm demo:rehearse        # the whole devnet demo against a local LiteSVM RPC; offline
```

Mutation testing runs locally (`pnpm mutation`), not on every push.

## Rules

- English only, in code, documents, commit messages and terminal output.
- Devnet and local only. No request of any kind to mainnet, read-only included.
- Keys live only in `.env`, which git ignores. Never print or log them. Vector keys come from
  public seeds: never fund them and never use them on a network.
- Take program addresses from the program client packages (`@solana-program/*`); never type them
  by hand.
- Pin exact dependency versions and commit `pnpm-lock.yaml`. pnpm refuses package versions
  published less than 7 days ago, and dependency install scripts do not run. A security fix newer
  than 7 days needs the maintainers' agreement first.
- A change to a check comes with a vector, or a unit test where the check is not about message
  bytes. Regenerate the vectors (`pnpm fixtures:generate`) and commit them with the change. Vector
  IDs are never renumbered or reused.
- A new reason code needs an entry in `docs/REASON_CODES.md`; a test checks the file.
- Record design decisions, with their reasons, in `docs/DECISIONS.md`. It wins over other
  development notes.
- Small commits in Conventional Commits format (`feat(core): ...`, `fix(x402): ...`, `docs: ...`).
- Do not describe the project as "audited", "certified", "first" or "only".

## x402 findings in other projects

If a vector shows that a third-party x402 implementation accepts a payment the spec forbids, or
would move value it should not, stop. Do not commit the vector, the result or a description of it,
and do not open an issue or pull request anywhere. Report it privately, as `SECURITY.md` describes.
