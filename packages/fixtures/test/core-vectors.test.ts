import { describe, expect, it } from 'vitest';

import { REASON_CODES, type ReasonCode } from '@nexbridge/solana-signing-firewall';

import { loadCoreVectors, runCoreVector } from '../src/run.js';

const vectors = await loadCoreVectors();

/** Codes that depend on the signer handed to withPolicy(), not on a vector's inputs. */
const SIGNER_ONLY: ReasonCode[] = [
  'SIGNER_ADDRESS_MISMATCH',
  'UNSUPPORTED_INNER_SIGNER',
  'SIGNATURE_INVALID',
];

describe('core vectors', () => {
  it('has at least 40 vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(40);
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const result = await runCoreVector(vector);
    expect(result.actual).toBe(result.expected);
  });

  it('exercises every reason code that depends only on the inputs', () => {
    const seen = new Set<ReasonCode>(
      vectors.flatMap((v) => [...v.expect.reasons, ...(v.expect.approval?.reasons ?? [])]),
    );
    const core = REASON_CODES.filter((code) => !code.startsWith('X402_'));
    const missing = core.filter((code) => !SIGNER_ONLY.includes(code) && !seen.has(code));
    expect(missing).toEqual([]);
  });
});
