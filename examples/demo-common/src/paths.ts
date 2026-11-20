import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, found from this file's location. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Where a demo run reads its keys and writes its records. */
export type DemoPaths = {
  /** The key file. For devnet it is the repository's `.env`, which git ignores. */
  readonly env: string;
  /** `.env.example`, copied as the starting point of a new key file. */
  readonly envExample: string;
  /** Public record of what setup created (addresses and setup signatures). */
  readonly setupState: string;
  /** The recorded run: scenes, decisions, approvals, quotes, signatures and slots. */
  readonly runRecord: string;
  /** The policy files used in the run, for anyone who wants to recompute the digests. */
  readonly policyDir: string;
  /** The Markdown table that `pnpm demo:record` writes. */
  readonly table: string;
  /** Budget files of the x402 agent. Not committed. */
  readonly ledgerDir: string;
};

export function devnetPaths(): DemoPaths {
  const runDir = join(REPO_ROOT, 'docs', 'devnet-run');
  return {
    env: join(REPO_ROOT, '.env'),
    envExample: join(REPO_ROOT, '.env.example'),
    setupState: join(runDir, 'setup.json'),
    runRecord: join(runDir, 'run.json'),
    policyDir: join(runDir, 'policies'),
    table: join(runDir, 'scenes.md'),
    ledgerDir: join(REPO_ROOT, 'examples', 'x402-agent', '.state'),
  };
}

/** Every path inside one directory: for rehearsals against a local RPC. */
export function pathsIn(dir: string): DemoPaths {
  return {
    env: join(dir, '.env'),
    envExample: join(REPO_ROOT, '.env.example'),
    setupState: join(dir, 'setup.json'),
    runRecord: join(dir, 'run.json'),
    policyDir: join(dir, 'policies'),
    table: join(dir, 'scenes.md'),
    ledgerDir: join(dir, 'ledger'),
  };
}
