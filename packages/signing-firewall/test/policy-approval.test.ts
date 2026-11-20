import { describe, expect, it } from 'vitest';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';

import {
  PolicyError,
  canonicalJson,
  createApproval,
  parsePolicy,
  policyDigest,
  review,
  sha256Hex,
  verifyApproval,
} from '../src/index.js';
import { policyFor, policyJson, snapshotFor, testWorld, transferTransaction } from './world.js';

const w = await testWorld();

describe('canonicalJson (RFC 8785)', () => {
  it('serializes numbers and strings as in RFC 8785 section 3.2.2', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units as in RFC 8785 section 3.2.3', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });
});

describe('parsePolicy', () => {
  it('fills strict defaults', () => {
    const policy = policyFor(w, { tokenBatch: undefined });
    expect(policy.tokenBatch).toBe('deny');
    expect(policy.durableNonce).toBe('deny');
    expect(policy.memo).toEqual({ allowed: false });
    expect(policy.recipients.requireAssociatedTokenAccount).toBe(true);
    expect(policy.fees.requireExplicitComputeUnitLimit).toBe(true);
  });

  it.each([
    ['an unknown field', { surprise: true }, /policy.surprise: unknown field/],
    [
      'an amount that is not a decimal string',
      { mints: { [w.mint]: { decimals: 6, maxPerTransaction: 5 } } },
      /maxPerTransaction: must be a decimal string/,
    ],
    [
      'an amount above u64',
      { mints: { [w.mint]: { decimals: 6, maxPerTransaction: '18446744073709551616' } } },
      /exceeds u64/,
    ],
    [
      'approvalAbove without an approval section',
      { approval: undefined },
      /needs an "approval" section/,
    ],
    [
      'a durable-nonce mode other than deny',
      { durableNonce: 'allow' },
      /durableNonce: must be one of "deny"/,
    ],
    [
      'a duplicate fee payer',
      { feePayers: [w.treasury.address, w.treasury.address] },
      /has duplicates/,
    ],
    ['a wrong schema', { schema: 'policykit.policy/v0' }, /schema: must be/],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => parsePolicy(policyJson(w, overrides))).toThrow(PolicyError);
    expect(() => parsePolicy(policyJson(w, overrides))).toThrow(message);
  });

  it('digests the canonical JSON, so key order does not matter', async () => {
    const json = policyJson(w);
    const reordered = Object.fromEntries(Object.entries(json).reverse());
    expect(await policyDigest(parsePolicy(reordered))).toBe(await policyDigest(parsePolicy(json)));
  });
});

describe('approvals', () => {
  const now = new Date('2026-11-20T00:00:00.000Z');
  const policy = policyFor(w);
  const message = new Uint8Array(transferTransaction(w, 3_000_000n).messageBytes);
  const other = new Uint8Array(transferTransaction(w, 4_500_000n).messageBytes);

  async function approval(
    options: { issued?: number; lifetime?: number; approver?: typeof w.approver } = {},
  ) {
    const decision = await review({ messageBytes: message, policy, snapshot: snapshotFor(w), now });
    const issuedAt = new Date(now.getTime() + (options.issued ?? -10) * 1000);
    return createApproval({
      decision,
      approver: options.approver ?? w.approver,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + (options.lifetime ?? 60) * 1000),
    });
  }

  const codes = async (record: unknown, messageBytes = message, p = policy) =>
    (await verifyApproval(record, { messageBytes, policy: p, now })).map((r) => r.code);

  it('binds to the message digest and the policy digest', async () => {
    const record = await approval();
    expect(record.messageDigest).toBe(await sha256Hex(message));
    expect(record.policyDigest).toBe(await policyDigest(policy));
    expect(await codes(record)).toEqual([]);
  });

  it('reports each failure', async () => {
    expect(await codes(await approval({ issued: -100 }))).toEqual(['APPROVAL_EXPIRED']);
    expect(await codes(await approval({ lifetime: 91 }))).toEqual(['APPROVAL_TTL_EXCEEDED']);
    expect(await codes(await approval({ issued: 5 }))).toEqual(['APPROVAL_TTL_EXCEEDED']);
    expect(await codes(await approval({ approver: w.outsider }))).toEqual(['APPROVER_NOT_ALLOWED']);
    expect(await codes(await approval(), other)).toEqual(['APPROVAL_MESSAGE_MISMATCH']);
    expect(await codes(await approval(), message, policyFor(w, { policyId: 'newer' }))).toEqual([
      'APPROVAL_POLICY_MISMATCH',
    ]);
  });

  it('rejects a tampered signature, a changed field and a malformed record', async () => {
    const record = await approval();
    const signature = new Uint8Array(getBase58Encoder().encode(record.signature));
    signature[10] = (signature[10] ?? 0) ^ 0xff;
    expect(await codes({ ...record, signature: getBase58Decoder().decode(signature) })).toEqual([
      'APPROVAL_SIGNATURE_INVALID',
    ]);
    expect(await codes({ ...record, expiresAt: '2026-11-20T00:00:30.000Z' })).toEqual([
      'APPROVAL_SIGNATURE_INVALID',
    ]);
    expect(await codes({ ...record, extra: 1 })).toEqual(['APPROVAL_SIGNATURE_INVALID']);
    expect(await codes('not a record')).toEqual(['APPROVAL_SIGNATURE_INVALID']);
  });
});
