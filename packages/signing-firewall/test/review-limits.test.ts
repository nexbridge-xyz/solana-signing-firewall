// Security review: limits of what review() and the x402 checks look at. Nothing here moves value
// against the policy; each test pins a behaviour the documents do not mention, so that a later
// change to it is deliberate. All of them pass at the reviewed commit. (That review() also
// ignored the packet size is fixed on fix/decoder-strict-encoding, with its own tests.)
import { describe, expect, it } from 'vitest';
import {
  type Blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token';

import { parseRequirements, review, sha256Hex } from '../src/index.js';
import { policyFor, snapshotFor, testWorld } from './world.js';

const w = await testWorld();
const snapshot = snapshotFor(w);
const now = new Date('2026-11-20T00:00:00.000Z');

function transferWith(blockhashBytes: Uint8Array) {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(w.treasury.address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: getBase58Decoder().decode(blockhashBytes) as Blockhash,
            lastValidBlockHeight: 0n,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: 30_000 }),
            getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
            getTransferCheckedInstruction({
              source: w.treasuryAta,
              mint: w.mint,
              destination: w.vendorAta,
              authority: w.treasury,
              amount: 1_000_000n,
              decimals: 6,
            }),
          ],
          m,
        ),
    ),
  );
}

describe('what review() does not look at', () => {
  it('the blockhash: any 32 bytes get the same decision, so nothing ties the bytes to the policy network', async () => {
    const policy = policyFor(w, { network: 'devnet' });
    const digests = new Set<string>();
    for (const fill of [0, 1, 9, 255]) {
      const transaction = transferWith(new Uint8Array(32).fill(fill));
      const messageBytes = new Uint8Array(transaction.messageBytes);
      const decision = await review({ messageBytes, policy, snapshot, now });
      expect([decision.outcome, decision.lifetime?.type]).toEqual(['allow', 'blockhash']);
      digests.add(sha256Hex(messageBytes));
    }
    // Four different messages, each allowed: a blockhash of any cluster would be too.
    expect(digests.size).toBe(4);
  });
});

describe('x402 quote fields', () => {
  it('an empty extra.memo is read as a seller memo of zero bytes, not as "no memo"', () => {
    const quote = {
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      amount: '20000',
      asset: w.mint,
      payTo: w.vendor.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: w.outsider.address, memo: '' },
    };
    const parsed = parseRequirements(quote);
    // The pinned @x402/svm client and facilitator treat '' as absent and use a hex nonce, so
    // the guard and the verifier refuse what they build for such a quote (X402_MEMO_MISMATCH).
    expect(parsed.ok && parsed.value.memo).toBe('');
  });

  it('extra.recentBlockhash and other unknown extra fields are kept and ignored', () => {
    const parsed = parseRequirements({
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      amount: '20000',
      asset: w.mint,
      payTo: w.vendor.address,
      maxTimeoutSeconds: 60,
      // The pinned client puts this value into the transaction as its blockhash.
      extra: { feePayer: w.outsider.address, recentBlockhash: '1'.repeat(32) },
    });
    expect(parsed.ok).toBe(true);
  });
});
