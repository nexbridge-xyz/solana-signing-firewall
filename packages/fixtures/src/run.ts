// Runs every core vector through review() and the approval check, and checks
// the decoded facts where a vector pins them. Exits non-zero on any failure.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { getBase64Encoder } from '@solana/kit';

import {
  type DecodedTransactionMessage,
  type ReasonCode,
  decodeTransactionMessage,
  parsePolicy,
  review,
  snapshotFromJson,
  verifyApproval,
} from '@nexbridge/solana-signing-firewall';

import type { CoreVector, DecodedExpectation } from './format.js';
import { CORE_DIR } from './paths.js';

export function project(decoded: DecodedTransactionMessage): DecodedExpectation {
  return {
    version: decoded.version,
    feePayer: decoded.feePayer,
    requiredSigners: [...decoded.requiredSigners],
    lifetime: decoded.lifetime.type,
    instructions: decoded.instructions.map((ix) => ({
      path: ix.path,
      program: ix.program,
      type:
        ix.program === 'spl-token'
          ? ix.token.type
          : ix.program === 'compute-budget'
            ? ix.computeBudget.type
            : ix.program === 'system'
              ? ix.advancesNonce
                ? 'advance-nonce-account'
                : 'other'
              : null,
    })),
    transfers: decoded.transfers.map((t) => ({
      path: t.path,
      source: t.source,
      mint: t.mint,
      destination: t.destination,
      authority: t.authority,
      amount: t.amount.toString(),
      decimals: t.decimals,
    })),
    fees:
      decoded.fees.source === 'instructions'
        ? {
            source: 'instructions',
            computeUnitLimit: decoded.fees.computeUnitLimit ?? null,
            computeUnitPriceMicroLamports:
              decoded.fees.computeUnitPriceMicroLamports?.toString() ?? null,
          }
        : {
            source: 'transactionConfig',
            computeUnitLimit: decoded.fees.computeUnitLimit ?? null,
            loadedAccountsDataSizeLimit: decoded.fees.loadedAccountsDataSizeLimit ?? null,
            heapSize: decoded.fees.heapSize ?? null,
            priorityFeeLamports: decoded.fees.priorityFeeLamports.toString(),
          },
    lookupTableEntries: decoded.lookupTableEntries.map((e) => ({ ...e })),
  };
}

export type VectorResult = {
  id: string;
  expected: string;
  actual: string;
  pass: boolean;
};

const sortedUnique = (codes: readonly ReasonCode[]) => [...new Set(codes)].sort();
const describe = (outcome: string, reasons: readonly ReasonCode[]) =>
  reasons.length === 0 ? outcome : `${outcome} ${sortedUnique(reasons).join(',')}`;

export async function runCoreVector(vector: CoreVector, dir = CORE_DIR): Promise<VectorResult> {
  const messageBytes = new Uint8Array(getBase64Encoder().encode(vector.message));
  const policy = parsePolicy(JSON.parse(await readFile(join(dir, vector.policy), 'utf8')));
  const snapshot = snapshotFromJson(vector.snapshot);
  const now = new Date(vector.now);
  const decision = await review({ messageBytes, policy, snapshot, now });

  const actualReasons = decision.reasons.map((r) => r.code);
  let expected = describe(vector.expect.outcome, vector.expect.reasons);
  let actual = describe(decision.outcome, actualReasons);
  let pass =
    decision.outcome === vector.expect.outcome &&
    isDeepStrictEqual(sortedUnique(actualReasons), sortedUnique(vector.expect.reasons));

  if (decision.outcome === 'needs_approval' || vector.expect.approval !== undefined) {
    const approvalReasons =
      vector.approval === undefined
        ? (['APPROVAL_REQUIRED'] as ReasonCode[])
        : (await verifyApproval(vector.approval, { messageBytes, policy, now })).map((r) => r.code);
    const expectedApproval = vector.expect.approval?.reasons ?? [];
    expected += ` | approval ${expectedApproval.length === 0 ? 'valid' : sortedUnique(expectedApproval).join(',')}`;
    actual += ` | approval ${approvalReasons.length === 0 ? 'valid' : sortedUnique(approvalReasons).join(',')}`;
    pass &&= isDeepStrictEqual(sortedUnique(approvalReasons), sortedUnique(expectedApproval));
  }

  if (vector.expect.decoded !== undefined) {
    const decoded = decodeTransactionMessage(messageBytes, snapshot);
    if (!decoded.ok || !isDeepStrictEqual(project(decoded.value), vector.expect.decoded)) {
      actual += ' | decoded facts differ';
      pass = false;
    }
  }
  return { id: vector.id, expected, actual, pass };
}

export async function loadCoreVectors(dir = CORE_DIR): Promise<CoreVector[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as CoreVector),
  );
}

async function main(): Promise<void> {
  const results: VectorResult[] = [];
  for (const vector of await loadCoreVectors()) results.push(await runCoreVector(vector));
  const width = (key: 'id' | 'expected' | 'actual') =>
    Math.max(key.length, ...results.map((r) => r[key].length));
  const row = (id: string, expected: string, actual: string, status: string) =>
    `${id.padEnd(width('id'))}  ${expected.padEnd(width('expected'))}  ${actual.padEnd(width('actual'))}  ${status}`;
  console.log(row('id', 'expected', 'actual', 'status'));
  for (const r of results) console.log(row(r.id, r.expected, r.actual, r.pass ? 'PASS' : 'FAIL'));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length} core vectors: ${results.length - failed} pass, ${failed} fail.`);
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) await main();
