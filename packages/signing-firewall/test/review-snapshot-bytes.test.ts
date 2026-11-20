// Security review: review() answers with a decision for any account bytes a snapshot can hold.
//
// The snapshot comes from an RPC. A token account whose state byte is not 0, 1 or 2 is something
// the token program never writes, but an RPC can serve it, and review() threw a codec error for
// it instead of returning a reason. No signature followed (the wrapper passes the error on), but
// review() is documented to return every failing reason, and a caller that handles only
// PolicyViolationError saw an unexpected crash.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { TOKEN_PROGRAM_ADDRESS, review } from '../src/index.js';
import {
  mintData,
  policyFor,
  snapshotFor,
  testWorld,
  tokenData,
  transferTransaction,
} from './world.js';

const w = await testWorld();
const policy = policyFor(w);
const messageBytes = new Uint8Array(transferTransaction(w, 1_000_000n).messageBytes);
const now = new Date('2026-11-20T00:00:00.000Z');

async function reviewWith(address: typeof w.mint, data: Uint8Array) {
  const accounts = new Map(snapshotFor(w).accounts);
  accounts.set(address, {
    owner: TOKEN_PROGRAM_ADDRESS,
    lamports: 2_039_280n,
    data,
    executable: false,
  });
  const decision = await review({ messageBytes, policy, snapshot: { slot: 100n, accounts }, now });
  return [decision.outcome, ...decision.reasons.map((r) => r.code)];
}

describe('account bytes the token program would never write', () => {
  it('a source token account with an unknown state byte is SOURCE_ACCOUNT_INVALID', async () => {
    const data = tokenData(w.mint, w.treasury.address, 50_000_000n);
    data[108] = 3;
    expect(await reviewWith(w.treasuryAta, data)).toEqual(['deny', 'SOURCE_ACCOUNT_INVALID']);
  });

  it('a destination token account with an unknown state byte is DESTINATION_ACCOUNT_INVALID', async () => {
    const data = tokenData(w.mint, w.vendor.address, 0n);
    data[108] = 255;
    expect(await reviewWith(w.vendorAta, data)).toEqual(['deny', 'DESTINATION_ACCOUNT_INVALID']);
  });

  it('never throws, whatever 165 or 82 bytes the snapshot holds for the mint or a token account', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(w.mint, w.treasuryAta, w.vendorAta),
        fc.oneof(
          fc.uint8Array({ minLength: 165, maxLength: 165 }),
          fc.uint8Array({ minLength: 82, maxLength: 82 }),
          // A real account with one byte changed: the interesting neighbours.
          fc.tuple(fc.nat(164), fc.integer({ min: 0, max: 255 })).map(([i, v]) => {
            const data = tokenData(w.mint, w.vendor.address, 0n);
            data[i] = v;
            return data;
          }),
          fc.tuple(fc.nat(81), fc.integer({ min: 0, max: 255 })).map(([i, v]) => {
            const data = mintData();
            data[i] = v;
            return data;
          }),
        ),
        async (address, data) => {
          const [outcome] = await reviewWith(address, data);
          expect(['allow', 'needs_approval', 'deny']).toContain(outcome);
        },
      ),
      { numRuns: 500 },
    );
  });
});
