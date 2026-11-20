// docs/REASON_CODES.md lists every reason code exactly once, and each vector it
// names expects that code. This keeps the document honest as codes and vectors change.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REASON_CODES } from '@nexbridge/solana-signing-firewall';

import { CORE_DIR, X402_DIR } from '../src/paths.js';

const DOC = join(import.meta.dirname, '..', '..', '..', 'docs', 'REASON_CODES.md');
const UNIT_TESTED = [
  'SIGNER_ADDRESS_MISMATCH',
  'UNSUPPORTED_INNER_SIGNER',
  'SIGNATURE_INVALID',
  'X402_SIGNER_ALREADY_USED',
];

/** Vectors store expected reasons as codes. */
type Expectation = { reasons?: string[] } | undefined;

function expectedCodes(): Map<string, Set<string>> {
  const byVector = new Map<string, Set<string>>();
  const add = (id: string, expectation: Expectation) => {
    const set = byVector.get(id) ?? new Set<string>();
    for (const code of expectation?.reasons ?? []) set.add(code);
    byVector.set(id, set);
  };
  for (const [dir, prefix] of [
    [CORE_DIR, 'core-'],
    [X402_DIR, 'x402-'],
  ] as const) {
    for (const file of readdirSync(dir).filter((f) => f.startsWith(prefix))) {
      const vector = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        id: string;
        expect: {
          reasons?: string[];
          approval?: Expectation;
          client?: Expectation;
          facilitator?: Expectation;
        };
      };
      add(vector.id, { reasons: vector.expect.reasons ?? [] });
      add(vector.id, vector.expect.approval);
      add(vector.id, vector.expect.client);
      add(vector.id, vector.expect.facilitator);
    }
  }
  return byVector;
}

describe('docs/REASON_CODES.md', () => {
  // Table rows of the form | `CODE` | meaning | raised by | vectors |, however Prettier pads them.
  const rows = readFileSync(DOC, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => ({
      code: (cells[1] ?? '').replace(/`/g, ''),
      raisedBy: cells[3] ?? '',
      vectors: cells[4] ?? '',
    }));

  it('lists every reason code exactly once, and nothing else', () => {
    expect(rows.map((r) => r.code).sort()).toEqual([...REASON_CODES].sort());
  });

  it('names, for each code, vectors that expect it (or a unit test for wrapper and signer codes)', () => {
    const expected = expectedCodes();
    for (const row of rows) {
      if (UNIT_TESTED.includes(row.code)) {
        expect(row.vectors, row.code).toMatch(/^unit test: `packages\/signing-firewall\/test\//);
        continue;
      }
      const ids = row.vectors.split(', ');
      expect(ids.length, row.code).toBeGreaterThan(0);
      for (const id of ids) {
        expect(expected.get(id)?.has(row.code), `${row.code} in ${id}`).toBe(true);
      }
    }
  });
});
