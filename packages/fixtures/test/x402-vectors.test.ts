import { describe, expect, it } from 'vitest';

import { REASON_CODES, type ReasonCode } from '@nexbridge/solana-signing-firewall';

import { loadX402Vectors, runX402Vector } from '../src/x402/run.js';

const vectors = await loadX402Vectors();

/** Depends on how the bound signer is used, not on a vector's inputs. */
const SIGNER_ONLY: ReasonCode[] = ['X402_SIGNER_ALREADY_USED'];

describe('x402 vectors', () => {
  it('has at least 30 vectors, including payments built by the SDK', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
    expect(vectors.filter((v) => v.specVerdict === 'must_accept').length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const result = await runX402Vector(vector);
    expect(result.actual).toBe(result.expected);
  });

  it('accepts on both sides every payment the spec says must be accepted', () => {
    for (const v of vectors.filter((x) => x.specVerdict === 'must_accept')) {
      expect([v.id, v.expect.client?.outcome, v.expect.facilitator?.outcome]).toEqual([
        v.id,
        'allow',
        'valid',
      ]);
    }
  });

  it('exercises every x402 reason code that depends only on the inputs', () => {
    const seen = new Set<ReasonCode>(
      vectors.flatMap((v) => [
        ...(v.expect.client?.reasons ?? []),
        ...(v.expect.facilitator?.reasons ?? []),
      ]),
    );
    const missing = REASON_CODES.filter(
      (c) => c.startsWith('X402_') && !SIGNER_ONLY.includes(c) && !seen.has(c),
    );
    expect(missing).toEqual([]);
  });
});
