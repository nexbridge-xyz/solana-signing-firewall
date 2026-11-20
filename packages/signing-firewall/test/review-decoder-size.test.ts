// Security review: a transaction that cannot fit in one packet.
//
// A cluster accepts at most 1,232 bytes for a legacy or version-0 transaction and 4,096 bytes for
// a version-1 transaction, signatures included (Kit: LEGACY_TRANSACTION_SIZE_LIMIT and
// V1_TRANSACTION_SIZE_LIMIT; x402 `exact` scheme for Solana, section 1.5: "A legacy or version-0
// transaction MUST NOT exceed 1232 serialized bytes; a version-1 transaction MUST NOT exceed 4096
// serialized bytes."). review() allowed larger messages. Nothing can move, because no cluster
// takes such a transaction; but the answer was "allow" for bytes that cannot be executed.
// LiteSVM does not enforce the packet limit, so this test rests on Kit's own limit.
import { describe, expect, it } from 'vitest';
import { LEGACY_TRANSACTION_SIZE_LIMIT, V1_TRANSACTION_SIZE_LIMIT } from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token';

import { SPL_MEMO_PROGRAM_ADDRESS, review } from '../src/index.js';
import { legacyMessage, v0Message, v1Message } from './helpers.js';
import { policyFor, snapshotFor, testWorld } from './world.js';

const w = await testWorld();
const policy = policyFor(w, {
  mints: { [w.mint]: { decimals: 6, maxPerTransaction: '5000000' } },
  memo: { allowed: true, maxBytes: 1024 },
  approval: undefined,
});
const snapshot = snapshotFor(w);
const now = new Date('2026-11-20T00:00:00.000Z');

const transfer = () =>
  getTransferCheckedInstruction({
    source: w.treasuryAta,
    mint: w.mint,
    destination: w.vendorAta,
    authority: w.treasury,
    amount: 1_000_000n,
    decimals: 6,
  });
const budget = () => [
  getSetComputeUnitLimitInstruction({ units: 30_000 }),
  getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
];
const memo = (bytes: number) => ({
  programAddress: SPL_MEMO_PROGRAM_ADDRESS,
  data: new TextEncoder().encode('m'.repeat(bytes)),
});

async function outcome(bytes: Uint8Array) {
  const decision = await review({ messageBytes: bytes, policy, snapshot, now });
  return [decision.outcome, ...decision.reasons.map((r) => r.code)];
}

describe('a message that cannot fit in one packet with its signatures', () => {
  it('is refused for legacy and version 0 above 1,232 bytes, and allowed just inside', async () => {
    const big = legacyMessage(w.treasury.address, [...budget(), transfer(), memo(700), memo(600)]);
    expect(1 + 64 + big.bytes.length).toBeGreaterThan(LEGACY_TRANSACTION_SIZE_LIMIT);
    expect(await outcome(big.bytes)).toEqual(['deny', 'MALFORMED_MESSAGE']);
    const bigV0 = v0Message(w.treasury.address, [...budget(), transfer(), memo(700), memo(600)]);
    expect(await outcome(bigV0.bytes)).toEqual(['deny', 'MALFORMED_MESSAGE']);

    const fits = legacyMessage(w.treasury.address, [...budget(), transfer(), memo(700)]);
    expect(1 + 64 + fits.bytes.length).toBeLessThanOrEqual(LEGACY_TRANSACTION_SIZE_LIMIT);
    expect(await outcome(fits.bytes)).toEqual(['allow']);
  });

  it('is refused for version 1 above 4,096 bytes, and allowed just inside', async () => {
    const config = { computeUnitLimit: 30_000, priorityFeeLamports: 10_000n };
    const memos = (n: number) => Array.from({ length: n }, () => memo(1000));
    const fits = v1Message(w.treasury.address, [transfer(), ...memos(3)], config);
    expect(fits.bytes.length + 64).toBeLessThanOrEqual(V1_TRANSACTION_SIZE_LIMIT);
    expect(await outcome(fits.bytes)).toEqual(['allow']);
    const big = v1Message(w.treasury.address, [transfer(), ...memos(4)], config);
    expect(big.bytes.length + 64).toBeGreaterThan(V1_TRANSACTION_SIZE_LIMIT);
    expect(await outcome(big.bytes)).toEqual(['deny', 'MALFORMED_MESSAGE']);
  });
});
