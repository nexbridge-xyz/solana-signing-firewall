import {
  type Address,
  type MessagePartialSigner,
  type SignatureBytes,
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  isAddress,
  verifySignature,
} from '@solana/kit';

import { canonicalJson, sha256Hex } from '../canonical.js';
import type { ReviewDecision } from '../evaluate/decision.js';
import { type Policy, policyDigest } from '../policy.js';
import type { Reason } from '../reasons.js';

export const APPROVAL_SCHEMA = 'solana-signing-firewall.approval/v0';
/** Domain-separation prefix: the approver signs this, then the canonical JSON of the record. */
export const APPROVAL_SIGNING_PREFIX = `${APPROVAL_SCHEMA}\n`;

/** A second person's Ed25519 approval of one exact message under one exact policy. */
export type ApprovalRecord = {
  readonly schema: typeof APPROVAL_SCHEMA;
  /** SHA-256 of the approved message bytes, hex. */
  readonly messageDigest: string;
  /** Digest of the policy the message was reviewed under, hex. */
  readonly policyDigest: string;
  /** ISO 8601, UTC. */
  readonly issuedAt: string;
  /** ISO 8601, UTC. */
  readonly expiresAt: string;
  readonly approver: Address;
  /** Ed25519 signature, base58. */
  readonly signature: string;
};

type UnsignedApproval = Omit<ApprovalRecord, 'signature'>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function signingBytes(unsigned: UnsignedApproval): Uint8Array {
  return new TextEncoder().encode(APPROVAL_SIGNING_PREFIX + canonicalJson(unsigned));
}

export async function createApproval(input: {
  readonly decision: Pick<ReviewDecision, 'messageDigest' | 'policyDigest'>;
  readonly approver: MessagePartialSigner;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}): Promise<ApprovalRecord> {
  const unsigned: UnsignedApproval = {
    schema: APPROVAL_SCHEMA,
    messageDigest: input.decision.messageDigest,
    policyDigest: input.decision.policyDigest,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    approver: input.approver.address,
  };
  const [signatures] = await input.approver.signMessages([
    createSignableMessage(signingBytes(unsigned)),
  ]);
  const signature = signatures?.[input.approver.address];
  if (signature === undefined) throw new Error('the approver returned no signature');
  return { ...unsigned, signature: getBase58Decoder().decode(signature) };
}

function parseRecord(record: unknown): ApprovalRecord | string {
  if (typeof record !== 'object' || record === null) return 'not an object';
  const r = record as Record<string, unknown>;
  const keys = [
    'schema',
    'messageDigest',
    'policyDigest',
    'issuedAt',
    'expiresAt',
    'approver',
    'signature',
  ];
  if (Object.keys(r).some((key) => !keys.includes(key))) return 'unknown field';
  if (r.schema !== APPROVAL_SCHEMA) return 'wrong schema';
  if (typeof r.messageDigest !== 'string' || !HEX_DIGEST.test(r.messageDigest))
    return 'bad messageDigest';
  if (typeof r.policyDigest !== 'string' || !HEX_DIGEST.test(r.policyDigest))
    return 'bad policyDigest';
  if (typeof r.issuedAt !== 'string' || !ISO_UTC.test(r.issuedAt)) return 'bad issuedAt';
  if (typeof r.expiresAt !== 'string' || !ISO_UTC.test(r.expiresAt)) return 'bad expiresAt';
  if (typeof r.approver !== 'string' || !isAddress(r.approver)) return 'bad approver';
  if (typeof r.signature !== 'string') return 'bad signature';
  return r as ApprovalRecord;
}

/**
 * Checks an approval against the exact message bytes and policy. Returns every
 * failing reason; an empty list means the approval is valid.
 */
export async function verifyApproval(
  record: unknown,
  context: { readonly messageBytes: Uint8Array; readonly policy: Policy; readonly now: Date },
): Promise<Reason[]> {
  const parsed = parseRecord(record);
  if (typeof parsed === 'string') {
    return [{ code: 'APPROVAL_SIGNATURE_INVALID', detail: `malformed record: ${parsed}` }];
  }
  const reasons: Reason[] = [];
  const { signature, ...unsigned } = parsed;

  let signatureValid: boolean;
  try {
    const bytes = getBase58Encoder().encode(signature);
    signatureValid =
      bytes.length === 64 &&
      (await verifySignature(
        await getPublicKeyFromAddress(parsed.approver),
        bytes as SignatureBytes,
        signingBytes(unsigned),
      ));
  } catch {
    signatureValid = false;
  }
  if (!signatureValid)
    reasons.push({ code: 'APPROVAL_SIGNATURE_INVALID', account: parsed.approver });

  const approval = context.policy.approval;
  if (approval === undefined || !approval.approvers.includes(parsed.approver)) {
    reasons.push({ code: 'APPROVER_NOT_ALLOWED', account: parsed.approver });
  }

  const issuedAt = Date.parse(parsed.issuedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  const now = context.now.getTime();
  if (now >= expiresAt) reasons.push({ code: 'APPROVAL_EXPIRED', detail: parsed.expiresAt });
  const ttlMs = (approval?.ttlSeconds ?? 0) * 1000;
  if (issuedAt > now || expiresAt <= issuedAt || expiresAt - issuedAt > ttlMs) {
    reasons.push({
      code: 'APPROVAL_TTL_EXCEEDED',
      detail: `issued ${parsed.issuedAt}, expires ${parsed.expiresAt}, ttl ${approval?.ttlSeconds ?? 0}s`,
    });
  }

  if (parsed.messageDigest !== (await sha256Hex(context.messageBytes))) {
    reasons.push({ code: 'APPROVAL_MESSAGE_MISMATCH' });
  }
  if (parsed.policyDigest !== (await policyDigest(context.policy))) {
    reasons.push({ code: 'APPROVAL_POLICY_MISMATCH' });
  }
  return reasons;
}
