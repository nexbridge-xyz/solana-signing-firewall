// Runs every core vector. Today (day 1) this checks the decoder: decode-level
// outcomes must match exactly, and decodable messages must decode to the facts
// in `expect.decoded`. Policy outcomes are checked once review() exists.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { getBase64Encoder } from '@solana/kit';

import {
  type DecodedTransactionMessage,
  type ReasonCode,
  decodeTransactionMessage,
  snapshotFromJson,
} from '@nexbridge/solana-signing-firewall';

import type { CoreVector, DecodedExpectation } from './format.js';
import { CORE_DIR } from './paths.js';

const DECODE_LEVEL = new Set<ReasonCode>([
  'MALFORMED_MESSAGE',
  'UNSUPPORTED_VERSION',
  'LOOKUP_TABLE_UNRESOLVED',
]);

function project(decoded: DecodedTransactionMessage): DecodedExpectation {
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

type Row = { id: string; expected: string; actual: string; status: 'PASS' | 'PENDING' | 'FAIL' };

function describe(outcome: string, reasons: readonly string[]): string {
  return reasons.length === 0 ? outcome : `${outcome} ${[...reasons].sort().join(',')}`;
}

function runVector(vector: CoreVector): Row {
  const bytes = new Uint8Array(getBase64Encoder().encode(vector.message));
  const result = decodeTransactionMessage(bytes, snapshotFromJson(vector.snapshot));
  const expected = describe(vector.expect.outcome, vector.expect.reasons);
  if (!result.ok) {
    const codes = [...new Set(result.reasons.map((r) => r.code))];
    const actual = describe('deny', codes);
    const pass =
      vector.expect.outcome === 'deny' &&
      vector.expect.decoded === undefined &&
      isDeepStrictEqual([...codes].sort(), [...vector.expect.reasons].sort());
    return { id: vector.id, expected, actual, status: pass ? 'PASS' : 'FAIL' };
  }
  if (
    vector.expect.decoded !== undefined &&
    !isDeepStrictEqual(project(result.value), vector.expect.decoded)
  ) {
    return { id: vector.id, expected, actual: 'decoded facts differ', status: 'FAIL' };
  }
  if (vector.expect.reasons.some((code) => DECODE_LEVEL.has(code))) {
    return {
      id: vector.id,
      expected,
      actual: 'decoded (expected a decode failure)',
      status: 'FAIL',
    };
  }
  return {
    id: vector.id,
    expected,
    actual: 'decoded as expected; policy check pending',
    status: 'PENDING',
  };
}

const names = (await readdir(CORE_DIR)).filter((name) => name.endsWith('.json')).sort();
const rows: Row[] = [];
for (const name of names) {
  const vector = JSON.parse(await readFile(join(CORE_DIR, name), 'utf8')) as CoreVector;
  rows.push(runVector(vector));
}

const width = (key: keyof Row) => Math.max(key.length, ...rows.map((row) => row[key].length));
const columns: (keyof Row)[] = ['id', 'expected', 'actual', 'status'];
const line = (cells: Record<keyof Row, string>) =>
  columns.map((key) => cells[key].padEnd(width(key))).join('  ');
console.log(line({ id: 'id', expected: 'expected', actual: 'decoder result', status: 'status' }));
for (const row of rows) console.log(line(row));

const count = (status: Row['status']) => rows.filter((row) => row.status === status).length;
console.log(
  `\n${rows.length} core vectors: ${count('PASS')} pass, ${count('PENDING')} decode as expected and wait for the policy evaluator, ${count('FAIL')} fail.`,
);
if (count('FAIL') > 0) process.exit(1);
