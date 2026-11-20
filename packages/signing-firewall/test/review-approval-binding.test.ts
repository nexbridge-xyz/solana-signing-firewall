// Security review, guarantee G3: an approval covers one message, one policy, one approver and one
// time window. Change a byte, the policy, the approver or the clock, and it stops working.
// These properties hold at the reviewed commit. (Times that are not times are a separate test.)
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit';

import {
  type ApprovalRecord,
  createApproval,
  policyDigest,
  sha256Hex,
  verifyApproval,
} from '../src/index.js';
import { policyFor, policyJson, testWorld, transferTransaction } from './world.js';

const w = await testWorld();
const policy = policyFor(w); // approvers: [w.approver], ttlSeconds: 90
const messageBytes = new Uint8Array(transferTransaction(w, 3_000_000n).messageBytes);
const issuedAt = new Date('2026-11-20T00:00:00.000Z');
const expiresAt = new Date('2026-11-20T00:01:00.000Z');
const inside = new Date('2026-11-20T00:00:30.000Z');

const approvalBy = (approver: typeof w.approver, bytes = messageBytes, forPolicy = policy) =>
  createApproval({
    decision: { messageDigest: sha256Hex(bytes), policyDigest: policyDigest(forPolicy) },
    approver,
    issuedAt,
    expiresAt,
  });
const valid = await approvalBy(w.approver);

const codes = async (
  record: unknown,
  context: Partial<{ messageBytes: Uint8Array; policy: typeof policy; now: Date }> = {},
) =>
  (await verifyApproval(record, { messageBytes, policy, now: inside, ...context })).map(
    (r) => r.code,
  );

describe('an approval is bound to its message, policy, approver and window', () => {
  it('is valid for exactly what it names (control)', async () => {
    expect(await codes(valid)).toEqual([]);
  });

  it('any one character changed in any field makes it invalid', async () => {
    const fields = Object.keys(valid) as (keyof ApprovalRecord)[];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...fields),
        fc.nat(),
        fc.constantFrom(...'0123456789abcdefABCDEFzZ:-.T+ '.split('')),
        async (field, position, replacement) => {
          const original = valid[field];
          const index = position % original.length;
          if (original[index] === replacement) return;
          const changed = original.slice(0, index) + replacement + original.slice(index + 1);
          expect(await codes({ ...valid, [field]: changed })).not.toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a field removed, added or of another type makes it invalid', async () => {
    for (const field of Object.keys(valid)) {
      const rest: Record<string, unknown> = { ...valid };
      Reflect.deleteProperty(rest, field);
      expect(await codes(rest)).toEqual(['APPROVAL_SIGNATURE_INVALID']);
      expect(await codes({ ...valid, [field]: 1 })).toEqual(['APPROVAL_SIGNATURE_INVALID']);
    }
    expect(await codes({ ...valid, note: 'approved' })).toEqual(['APPROVAL_SIGNATURE_INVALID']);
  });

  it('does not cover any other message bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.integer({ min: 1, max: 255 }), async (position, flip) => {
        const other = new Uint8Array(messageBytes);
        const index = position % other.length;
        other[index] = (other[index] ?? 0) ^ flip;
        expect(await codes(valid, { messageBytes: other })).toEqual(['APPROVAL_MESSAGE_MISMATCH']);
      }),
      { numRuns: 200 },
    );
  });

  it('does not cover any other policy, however small the difference', async () => {
    const variants: Record<string, unknown>[] = [
      { policyId: 'test-2' },
      { network: 'devnet' },
      { recipients: { owners: [w.vendor.address, w.outsider.address] } },
      {
        mints: {
          [w.mint]: { decimals: 6, maxPerTransaction: '5000001', approvalAbove: '2000000' },
        },
      },
      { approval: { approvers: [w.approver.address], ttlSeconds: 91 } },
      { tokenBatch: 'deny' },
      { memo: { allowed: false } },
    ];
    for (const override of variants) {
      const other = policyFor(w, override);
      expect(await codes(valid, { policy: other })).toContain('APPROVAL_POLICY_MISMATCH');
    }
    // The same policy with its keys in another order is the same policy.
    const reordered = Object.fromEntries(Object.entries(policyJson(w)).reverse());
    expect(await codes(valid, { policy: policyFor(w, reordered) })).toEqual([]);
  });

  it('cannot be issued by anyone but a listed approver', async () => {
    const stranger = await generateKeyPairSigner();
    expect(await codes(await approvalBy(stranger))).toEqual(['APPROVER_NOT_ALLOWED']);
    // A stranger signs, and writes a listed approver's address into the record.
    const forged = { ...(await approvalBy(stranger)), approver: w.approver.address };
    expect(await codes(forged)).toEqual(['APPROVAL_SIGNATURE_INVALID']);
    // The treasury's own key is not an approver either.
    expect(await codes(await approvalBy(w.treasury))).toEqual(['APPROVER_NOT_ALLOWED']);
    // A policy without an approval section accepts no approval at all.
    const none = policyFor(w, {
      approval: undefined,
      mints: { [w.mint]: { decimals: 6, maxPerTransaction: '5000000' } },
    });
    expect(await codes(await approvalBy(w.approver, messageBytes, none), { policy: none })).toEqual(
      ['APPROVER_NOT_ALLOWED', 'APPROVAL_TTL_EXCEEDED'],
    );
  });

  it('a signature by the approver over something else is not an approval', async () => {
    const sign = async (bytes: Uint8Array) =>
      getBase58Decoder().decode(await signBytes(w.approver.keyPair.privateKey, bytes));
    const unsigned: Record<string, unknown> = { ...valid };
    Reflect.deleteProperty(unsigned, 'signature');
    const json = JSON.stringify(unsigned, Object.keys(unsigned).sort());
    // The transaction message itself; the record without the prefix; the prefix with other JSON.
    for (const bytes of [
      messageBytes,
      new TextEncoder().encode(json),
      new TextEncoder().encode(`solana-signing-firewall.approval/v1\n${json}`),
      new TextEncoder().encode(`solana-signing-firewall.approval/v0\n${JSON.stringify(unsigned)} `),
    ]) {
      expect(await codes({ ...valid, signature: await sign(bytes) })).toEqual([
        'APPROVAL_SIGNATURE_INVALID',
      ]);
    }
  });

  it('works only inside its window, and the window cannot exceed the policy', async () => {
    const at = (iso: string) => codes(valid, { now: new Date(iso) });
    expect(await at('2026-11-19T23:59:59.999Z')).toEqual(['APPROVAL_TTL_EXCEEDED']); // not yet issued
    expect(await at('2026-11-20T00:00:00.000Z')).toEqual([]);
    expect(await at('2026-11-20T00:00:59.999Z')).toEqual([]);
    expect(await at('2026-11-20T00:01:00.000Z')).toEqual(['APPROVAL_EXPIRED']);
    expect(await at('2036-01-01T00:00:00.000Z')).toEqual(['APPROVAL_EXPIRED']);
    const long = await createApproval({
      decision: { messageDigest: sha256Hex(messageBytes), policyDigest: policyDigest(policy) },
      approver: w.approver,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 90_001),
    });
    expect(await codes(long)).toEqual(['APPROVAL_TTL_EXCEEDED']);
  });
});
