// Security review, guarantee G2: anything review() cannot decode the way the runtime does is denied.
//
// Kit's codec reads two encodings the runtime's deserializer does not:
//   - an array whose length prefix is missing at the very end of the bytes reads as empty, so a
//     version-0 message without its lookup-table count, and a legacy message without its
//     instruction count, decode;
//   - a length written in more bytes than it needs (0x83 0x00 for 3) decodes.
// The runtime refuses both, so neither can move anything; but review() answered "allow" for
// bytes the runtime cannot read, and a signature was given for them.
import { describe, expect, it } from 'vitest';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token';

import { decodeCompiledMessage, review } from '../src/index.js';
import { legacyMessage, v0Message } from './helpers.js';
import { policyFor, snapshotFor, testWorld } from './world.js';

const w = await testWorld();
const policy = policyFor(w, {
  mints: { [w.mint]: { decimals: 6, maxPerTransaction: '5000000' } },
  approval: undefined,
});
const snapshot = snapshotFor(w);
const now = new Date('2026-11-20T00:00:00.000Z');

const transfer = (amount = 1_000_000n) =>
  getTransferCheckedInstruction({
    source: w.treasuryAta,
    mint: w.mint,
    destination: w.vendorAta,
    authority: w.treasury,
    amount,
    decimals: 6,
  });
const budget = () => [
  getSetComputeUnitLimitInstruction({ units: 30_000 }),
  getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
];
async function outcome(bytes: Uint8Array) {
  const decision = await review({ messageBytes: bytes, policy, snapshot, now });
  return [decision.outcome, ...decision.reasons.map((r) => r.code)];
}

describe('the decoder accepts only what the runtime can deserialize', () => {
  it('allows the complete messages these tests start from (control)', async () => {
    const instructions = [...budget(), transfer()];
    expect(await outcome(v0Message(w.treasury.address, instructions).bytes)).toEqual(['allow']);
    expect(await outcome(legacyMessage(w.treasury.address, instructions).bytes)).toEqual(['allow']);
  });

  it('refuses a version-0 message that ends before its lookup-table count', async () => {
    const complete = v0Message(w.treasury.address, [...budget(), transfer()]).bytes;
    expect(complete.at(-1)).toBe(0); // the count of address table lookups
    const truncated = complete.slice(0, -1);
    // Kit reads the missing array as empty and reports the whole input consumed.
    const [, offset] = getCompiledTransactionMessageDecoder().read(truncated, 0);
    expect(offset).toBe(truncated.length);

    expect(decodeCompiledMessage(truncated).ok).toBe(false);
    expect(await outcome(truncated)).toEqual(['deny', 'MALFORMED_MESSAGE']);
  });

  it('refuses a legacy message that ends before its instruction count', async () => {
    const complete = legacyMessage(w.treasury.address, []).bytes;
    expect(complete.at(-1)).toBe(0); // the count of instructions
    const truncated = complete.slice(0, -1);
    const lenient = policyFor(w, {
      fees: {
        maxComputeUnitLimit: 200000,
        maxPriorityFeeLamports: '50000',
        requireExplicitComputeUnitLimit: false,
      },
    });
    const decision = await review({ messageBytes: truncated, policy: lenient, snapshot, now });
    expect([decision.outcome, ...decision.reasons.map((r) => r.code)]).toEqual([
      'deny',
      'MALFORMED_MESSAGE',
    ]);
  });

  it('refuses a length written in more bytes than it needs', async () => {
    const complete = legacyMessage(w.treasury.address, [...budget(), transfer()]).bytes;
    // Byte 3 is the count of static accounts. Write it as a two-byte compact-u16 instead.
    const count = complete[3] as number;
    const padded = new Uint8Array([...complete.slice(0, 3), count | 0x80, 0, ...complete.slice(4)]);
    expect(await outcome(padded)).toEqual(['deny', 'MALFORMED_MESSAGE']);
  });
});
