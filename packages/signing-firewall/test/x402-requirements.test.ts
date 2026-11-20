import { describe, expect, it } from 'vitest';

import { MAX_SELLER_MEMO_BYTES, parseRequirements, requirementsDigest } from '../src/index.js';

const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SHOP = 'CZcNunzw25bmfcnwPT2nKugfpcVx6ULu5js14QTjckGM';
const FEE_PAYER = '8wpoP1xJkigMBmSHGGa1HNS4BdtU6267DiCCk9ng4sjJ';

const base = {
  scheme: 'exact',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  asset: USDC,
  amount: '20000',
  payTo: SHOP,
  maxTimeoutSeconds: 60,
  extra: { feePayer: FEE_PAYER },
};
const without = (key: string) =>
  Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));

describe('parseRequirements', () => {
  it('parses a quote and reads absent fields as the spec does', () => {
    const parsed = parseRequirements(base);
    expect(parsed).toEqual({
      ok: true,
      value: {
        scheme: 'exact',
        network: base.network,
        asset: USDC,
        amount: 20_000n,
        payTo: SHOP,
        maxTimeoutSeconds: 60,
        feePayer: FEE_PAYER,
        memo: undefined,
        splitCount: 0,
        ataCreationRequired: false,
        transactionVersions: [0],
        json: base,
      },
    });
    const minimal = parseRequirements(without('extra'));
    expect(minimal.ok && minimal.value.feePayer).toBe(undefined);
    // A null extra reads as no extra; the quote checks then refuse the missing fee payer.
    const nullExtra = parseRequirements({ ...base, extra: null });
    expect(nullExtra.ok && nullExtra.value.feePayer).toBe(undefined);
  });

  it('reads the optional extra fields', () => {
    const parsed = parseRequirements({
      ...base,
      maxTimeoutSeconds: 1,
      amount: '18446744073709551615',
      extra: {
        feePayer: FEE_PAYER,
        memo: 'm'.repeat(MAX_SELLER_MEMO_BYTES),
        splits: [{}, {}],
        ataCreationRequired: true,
        transactionVersions: [1, 0],
        somethingNew: 'kept and ignored',
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      amount: 18_446_744_073_709_551_615n,
      maxTimeoutSeconds: 1,
      memo: 'm'.repeat(256),
      splitCount: 2,
      ataCreationRequired: true,
      transactionVersions: [1, 0],
    });
    const none = parseRequirements({ ...base, extra: { transactionVersions: [] } });
    expect(none.ok && none.value.transactionVersions).toEqual([]);
    const notSet = parseRequirements({ ...base, extra: { ataCreationRequired: false } });
    expect(notSet.ok && notSet.value.ataCreationRequired).toBe(false);
  });

  it('names what is malformed', () => {
    const cases: [unknown, string][] = [
      [null, 'not an object'],
      [[], 'not an object'],
      ['exact', 'not an object'],
      ...(['scheme', 'network', 'asset', 'amount', 'payTo'] as const).flatMap(
        (key): [unknown, string][] => [
          [without(key), `${key} must be a non-empty string`],
          [{ ...base, [key]: '' }, `${key} must be a non-empty string`],
          [{ ...base, [key]: 5 }, `${key} must be a non-empty string`],
        ],
      ),
      [{ ...base, amount: '020000' }, 'amount must be a decimal string of base units within u64'],
      [{ ...base, amount: '2e4' }, 'amount must be a decimal string of base units within u64'],
      [
        { ...base, amount: '18446744073709551616' },
        'amount must be a decimal string of base units within u64',
      ],
      [{ ...base, asset: 'not-an-address' }, 'asset is not an address'],
      [{ ...base, payTo: 'not-an-address' }, 'payTo is not an address'],
      [without('maxTimeoutSeconds'), 'maxTimeoutSeconds must be a positive integer'],
      [{ ...base, maxTimeoutSeconds: 0 }, 'maxTimeoutSeconds must be a positive integer'],
      [{ ...base, maxTimeoutSeconds: 1.5 }, 'maxTimeoutSeconds must be a positive integer'],
      [{ ...base, maxTimeoutSeconds: '60' }, 'maxTimeoutSeconds must be a positive integer'],
      [{ ...base, extra: 5 }, 'extra must be an object'],
      [{ ...base, extra: [] }, 'extra must be an object'],
      [{ ...base, extra: { feePayer: 5 } }, 'extra.feePayer is not an address'],
      [{ ...base, extra: { feePayer: 'nope' } }, 'extra.feePayer is not an address'],
      [{ ...base, extra: { memo: 5 } }, 'extra.memo must be a string'],
      [{ ...base, extra: { memo: 'm'.repeat(257) } }, 'extra.memo exceeds 256 bytes'],
      [{ ...base, extra: { memo: 'é'.repeat(129) } }, 'extra.memo exceeds 256 bytes'],
      [{ ...base, extra: { splits: {} } }, 'extra.splits must be an array'],
      [
        { ...base, extra: { ataCreationRequired: 'yes' } },
        'extra.ataCreationRequired must be a boolean',
      ],
      [
        { ...base, extra: { transactionVersions: 1 } },
        'extra.transactionVersions must contain only 0 and 1',
      ],
      [
        { ...base, extra: { transactionVersions: [0, 2] } },
        'extra.transactionVersions must contain only 0 and 1',
      ],
      [
        { ...base, extra: { transactionVersions: ['0'] } },
        'extra.transactionVersions must contain only 0 and 1',
      ],
    ];
    for (const [input, detail] of cases) {
      expect(parseRequirements(input), detail).toEqual({
        ok: false,
        reason: { code: 'X402_REQUIREMENTS_MALFORMED', detail },
      });
    }
  });

  it('digests the option as received, whatever its key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(requirementsDigest(reordered)).toBe(requirementsDigest(base));
    expect(requirementsDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requirementsDigest({ ...base, amount: '20001' })).not.toBe(requirementsDigest(base));
  });
});
