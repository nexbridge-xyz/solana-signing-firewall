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

  it('digests the canonical JSON, so key order does not matter', () => {
    const json = policyJson(w);
    const reordered = Object.fromEntries(Object.entries(json).reverse());
    expect(policyDigest(parsePolicy(reordered))).toBe(policyDigest(parsePolicy(json)));
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
    expect(record.messageDigest).toBe(sha256Hex(message));
    expect(record.policyDigest).toBe(policyDigest(policy));
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

describe('approval records: every malformed field and every time boundary', () => {
  const now = new Date('2026-11-20T00:00:00.000Z');
  const policy = policyFor(w);
  const message = new Uint8Array(transferTransaction(w, 3_000_000n).messageBytes);

  async function approval(issuedOffsetMs: number, lifetimeMs: number) {
    const decision = await review({ messageBytes: message, policy, snapshot: snapshotFor(w), now });
    const issuedAt = new Date(now.getTime() + issuedOffsetMs);
    return createApproval({
      decision,
      approver: w.approver,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + lifetimeMs),
    });
  }
  const verify = (record: unknown, p = policy) =>
    verifyApproval(record, { messageBytes: message, policy: p, now });

  it('names the malformed field', async () => {
    const record = await approval(-10_000, 60_000);
    const cases: [unknown, string][] = [
      [null, 'not an object'],
      [7, 'not an object'],
      [{ ...record, extra: 1 }, 'unknown field'],
      [{ ...record, schema: 'solana-signing-firewall.approval/v1' }, 'wrong schema'],
      [{ ...record, messageDigest: record.messageDigest.toUpperCase() }, 'bad messageDigest'],
      [{ ...record, messageDigest: 5 }, 'bad messageDigest'],
      [{ ...record, policyDigest: record.policyDigest.slice(1) }, 'bad policyDigest'],
      [{ ...record, policyDigest: null }, 'bad policyDigest'],
      [{ ...record, issuedAt: '2026-11-20 00:00:00Z' }, 'bad issuedAt'],
      [{ ...record, issuedAt: 0 }, 'bad issuedAt'],
      [{ ...record, expiresAt: '2026-11-20T00:01:00+00:00' }, 'bad expiresAt'],
      [{ ...record, expiresAt: 0 }, 'bad expiresAt'],
      [{ ...record, approver: 'not-an-address' }, 'bad approver'],
      [{ ...record, approver: 1 }, 'bad approver'],
      [{ ...record, signature: 1 }, 'bad signature'],
    ];
    for (const [input, problem] of cases) {
      expect(await verify(input), problem).toEqual([
        { code: 'APPROVAL_SIGNATURE_INVALID', detail: `malformed record: ${problem}` },
      ]);
    }
  });

  it('refuses a signature that is not base58 or not 64 bytes', async () => {
    const record = await approval(-10_000, 60_000);
    const short = getBase58Decoder().decode(
      new Uint8Array(getBase58Encoder().encode(record.signature)).slice(0, 63),
    );
    for (const signature of ['0OIl', short]) {
      expect(await verify({ ...record, signature })).toEqual([
        { code: 'APPROVAL_SIGNATURE_INVALID', account: w.approver.address },
      ]);
    }
  });

  it('expires exactly at expiresAt, and allows exactly ttlSeconds', async () => {
    const codes = async (issued: number, lifetime: number, p = policy) =>
      (await verify(await approval(issued, lifetime), p)).map((r) => r.code);
    expect(await codes(-60_000, 60_000)).toEqual(['APPROVAL_EXPIRED']);
    expect(await codes(-59_999, 60_000)).toEqual([]);
    expect(await codes(-10_000, 90_000)).toEqual([]);
    expect(await codes(-10_000, 90_001)).toEqual(['APPROVAL_TTL_EXCEEDED']);
    expect(await codes(0, 60_000)).toEqual([]);
    expect(await codes(1, 60_000)).toEqual(['APPROVAL_TTL_EXCEEDED']);
    expect(await codes(-10_000, 0)).toEqual(['APPROVAL_EXPIRED', 'APPROVAL_TTL_EXCEEDED']);
    const noApprovals = policyFor(w, {
      mints: { [w.mint]: { decimals: 6, maxPerTransaction: '5000000' } },
      approval: undefined,
    });
    expect(await codes(-10_000, 60_000, noApprovals)).toEqual([
      'APPROVER_NOT_ALLOWED',
      'APPROVAL_TTL_EXCEEDED',
      'APPROVAL_POLICY_MISMATCH',
    ]);
  });

  it('refuses to create an approval when the approver returns no signature', async () => {
    const decision = await review({ messageBytes: message, policy, snapshot: snapshotFor(w), now });
    const silent = { address: w.approver.address, signMessages: () => Promise.resolve([{}]) };
    await expect(
      createApproval({ decision, approver: silent, issuedAt: now, expiresAt: now }),
    ).rejects.toThrow(Error);
  });
});
