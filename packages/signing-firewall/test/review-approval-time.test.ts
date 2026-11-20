// Security review, guarantee G3: an approval covers one time window, and stops working when the
// clock leaves it.
//
// `issuedAt` and `expiresAt` are strings the approver signs. A string can have the shape of an
// ISO 8601 time and still not be a time: a 61st second, a 13th month, a 25th hour. Date.parse()
// answers NaN for those, and every comparison with NaN is false, so a check written as
// "refuse when now >= expiresAt" lets the approval through for ever. Such a record does not need a
// forged signature: any approver tool other than createApproval() can produce one (a leap second
// is written 23:59:60), and a requester who prepares the record for the approver to sign can
// choose the string.
import { describe, expect, it } from 'vitest';
import { getBase58Decoder, signBytes } from '@solana/kit';

import {
  APPROVAL_SCHEMA,
  APPROVAL_SIGNING_PREFIX,
  type ApprovalRecord,
  canonicalJson,
  policyDigest,
  sha256Hex,
  verifyApproval,
} from '../src/index.js';
import { policyFor, testWorld, transferTransaction } from './world.js';

const w = await testWorld();
const policy = policyFor(w); // ttlSeconds: 90
const messageBytes = new Uint8Array(transferTransaction(w, 3_000_000n).messageBytes);

/** An approval signed by the real approver over exactly the strings given. */
async function signedRecord(issuedAt: string, expiresAt: string): Promise<ApprovalRecord> {
  const unsigned: Omit<ApprovalRecord, 'signature'> = {
    schema: APPROVAL_SCHEMA,
    messageDigest: sha256Hex(messageBytes),
    policyDigest: policyDigest(policy),
    issuedAt,
    expiresAt,
    approver: w.approver.address,
  };
  const bytes = new TextEncoder().encode(APPROVAL_SIGNING_PREFIX + canonicalJson(unsigned));
  const signature = await signBytes(w.approver.keyPair.privateKey, bytes);
  return { ...unsigned, signature: getBase58Decoder().decode(signature) };
}

const codes = async (record: ApprovalRecord, now: string) =>
  (await verifyApproval(record, { messageBytes, policy, now: new Date(now) })).map((r) => r.code);

describe('approval times that are not times', () => {
  it('accepts a well-formed approval inside its window (control)', async () => {
    const record = await signedRecord('2026-11-20T00:00:00.000Z', '2026-11-20T00:01:00.000Z');
    expect(await codes(record, '2026-11-20T00:00:30.000Z')).toEqual([]);
    expect(await codes(record, '2026-11-20T00:01:00.000Z')).toEqual(['APPROVAL_EXPIRED']);
  });

  it.each([
    ['a 61st second (how a leap second is written)', '2026-11-20T23:59:60Z'],
    ['a 13th month', '2026-13-01T00:00:00Z'],
    ['a 25th hour', '2026-11-20T25:00:00Z'],
    ['a 61st minute', '2026-11-20T23:60:00.000Z'],
    ['day zero', '2026-11-00T00:00:00Z'],
  ])('refuses expiresAt with %s, years later', async (_what, expiresAt) => {
    const record = await signedRecord('2026-11-20T00:00:00.000Z', expiresAt);
    // Five years on, with a policy that caps an approval at 90 seconds.
    expect(await codes(record, '2031-11-20T00:00:00.000Z')).not.toEqual([]);
    expect(await codes(record, '2026-11-20T00:00:30.000Z')).not.toEqual([]);
  });

  it('refuses issuedAt that is not a time, so the 90-second cap cannot be skipped', async () => {
    // expiresAt is a real time a year ahead; with issuedAt unreadable the ttl check is void.
    const record = await signedRecord('2026-11-20T00:00:60Z', '2027-11-20T00:00:00.000Z');
    expect(await codes(record, '2027-06-01T00:00:00.000Z')).not.toEqual([]);
  });

  it('refuses every approval when the verifier is handed a clock that is not a time', async () => {
    const record = await signedRecord('2026-11-20T00:00:00.000Z', '2026-11-20T00:01:00.000Z');
    const reasons = await verifyApproval(record, { messageBytes, policy, now: new Date(NaN) });
    expect(reasons.map((r) => r.code)).toEqual(['APPROVAL_EXPIRED', 'APPROVAL_TTL_EXCEEDED']);
  });

  it('refuses a date that does not exist instead of reading it as another day', async () => {
    // 30 February is read by Date.parse() as 2 March: the approver signed one string, the
    // verifier enforces another day.
    const record = await signedRecord('2026-02-29T23:59:30.000Z', '2026-02-30T00:00:00.000Z');
    expect(await codes(record, '2026-03-01T23:59:45.000Z')).not.toEqual([]);
  });
});
