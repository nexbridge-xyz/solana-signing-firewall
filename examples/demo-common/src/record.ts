// The recorded run (docs/devnet-run/run.json) and the setup record. Both are
// public: they hold addresses, digests, signatures and slots, never keys.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RUN_SCHEMA = 'solana-signing-firewall.demo-run/v0';
export const SETUP_SCHEMA = 'solana-signing-firewall.demo-setup/v0';

export type ReasonRecord = { code: string; path?: string; account?: string; program?: string };

export type QuoteRecord = {
  option: number;
  requirementsDigest: string;
  payTo: string;
  asset: string;
  amount: string;
  feePayer: string | undefined;
  /** `deny` with reasons when the guard saw it; `removed by the SDK` when it never reached the guard. */
  outcome: string;
  reasons: string[];
};

/** One attempt within a scene: a review, a signing, a purchase or a verification. */
export type StepRecord = {
  label: string;
  outcome: string;
  reasons: ReasonRecord[];
  /** SHA-256 of the message bytes that were reviewed, hex. */
  messageDigest?: string;
  policyId?: string;
  signerCalls: number;
  sent: boolean;
  signature?: string;
  slot?: string;
  explorer?: string;
  decision?: unknown;
  approval?: unknown;
  quotes?: QuoteRecord[];
  note?: string;
};

export type SceneRecord = {
  scene: number;
  title: string;
  expected: string;
  /** Test vectors that cover the same rule. */
  vectors: string[];
  steps: StepRecord[];
};

export type RunRecord = {
  schema: typeof RUN_SCHEMA;
  network: string;
  startedAt: string;
  finishedAt: string;
  signer: string;
  cast: { role: string; name: string; address: string }[];
  policies: { policyId: string; digest: string; file: string }[];
  scenes: SceneRecord[];
  balances: { account: string; asset: string; before: string; after: string }[];
};

export type SetupStepRecord = {
  step: string;
  label: 'setup, not a scene' | 'recycle, not a scene';
  signature?: string;
  slot?: string;
  explorer?: string;
  note?: string;
};

export type SetupRecord = {
  schema: typeof SETUP_SCHEMA;
  network: string;
  lookupTable?: string;
  lookupTableEntries?: string[];
  steps: SetupStepRecord[];
};

/** Writes JSON (bigints as decimal strings) through a temporary file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  const temp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temp, `${text}\n`);
  renameSync(temp, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readRunRecord(path: string): RunRecord {
  const value = readJson(path);
  if ((value as { schema?: unknown } | null)?.schema !== RUN_SCHEMA) {
    throw new Error(`${path} is not a ${RUN_SCHEMA} record`);
  }
  return value as RunRecord;
}

export function readSetupRecord(path: string): SetupRecord {
  const value = readJson(path);
  if ((value as { schema?: unknown } | null)?.schema !== SETUP_SCHEMA) {
    throw new Error(`${path} is not a ${SETUP_SCHEMA} record`);
  }
  return value as SetupRecord;
}
