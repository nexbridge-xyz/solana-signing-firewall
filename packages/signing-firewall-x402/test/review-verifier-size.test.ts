// Security review: the facilitator-side verifier and the size of a payment.
//
// The x402 `exact` scheme for Solana (pinned commit 4f64aba41), section 1.5: "A legacy or version-0
// transaction MUST NOT exceed 1232 serialized bytes; a version-1 transaction MUST NOT exceed 4096
// serialized bytes." verifyX402Payment() answered `valid` for larger payments. The verifier lets
// extra Memos after the transfer carry any content, so the size is the only bound on them.
import { describe, expect, it } from 'vitest';
import { type Address, getBase64Encoder } from '@solana/kit';

import {
  type SnapshotAccount,
  parseVerifierConfig,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';
import {
  SDK_V1_CONFIG,
  budgetInstructions,
  createX402World,
  facilitatorConfig,
  handBuilt,
  memoInstruction,
  quote,
  transferInstruction,
  x402Accounts,
} from '@nexbridge/solana-signing-firewall-fixtures/x402';

const w = await createX402World();
const config = parseVerifierConfig(facilitatorConfig(w));
const snapshot = {
  slot: 1000n,
  accounts: new Map<Address, SnapshotAccount | null>(x402Accounts(w)),
};
const now = new Date('2026-11-20T00:00:00.000Z');
const nonce = 'ab'.repeat(16);

async function verdict(transaction: string) {
  const decision = await verifyX402Payment({
    transaction,
    requirements: quote(w),
    config,
    snapshot,
    now,
  });
  return {
    size: getBase64Encoder().encode(transaction).length,
    answer: [decision.outcome, ...decision.reasons.map((r) => r.code)],
  };
}

describe('verifyX402Payment() and the packet size', () => {
  it('refuses a version-0 payment over 1,232 bytes', async () => {
    // A valid payment, then a second Memo of 900 characters after the transfer.
    const large = await verdict(
      await handBuilt(w, {
        version: 0,
        instructions: [
          ...budgetInstructions(),
          transferInstruction(w),
          memoInstruction(nonce),
          memoInstruction('x'.repeat(900)),
        ],
      }),
    );
    expect(large.size).toBeGreaterThan(1232);
    expect(large.answer).toEqual(['invalid', 'MALFORMED_MESSAGE']);

    const small = await verdict(
      await handBuilt(w, {
        version: 0,
        instructions: [
          ...budgetInstructions(),
          transferInstruction(w),
          memoInstruction(nonce),
          memoInstruction('x'.repeat(100)),
        ],
      }),
    );
    expect(small.size).toBeLessThanOrEqual(1232);
    expect(small.answer).toEqual(['valid']);
  });

  it('refuses a version-1 payment over 4,096 bytes', async () => {
    const large = await verdict(
      await handBuilt(w, {
        version: 1,
        config: SDK_V1_CONFIG,
        instructions: [
          transferInstruction(w),
          memoInstruction(nonce),
          ...Array.from({ length: 4 }, () => memoInstruction('x'.repeat(1000))),
        ],
      }),
    );
    expect(large.size).toBeGreaterThan(4096);
    expect(large.answer).toEqual(['invalid', 'MALFORMED_MESSAGE']);
  });
});
