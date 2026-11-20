import {
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
  getPublicKeyFromAddress,
  verifySignature,
} from '@solana/kit';

import { type ApprovalRecord, verifyApproval } from '../approval/approval.js';
import type { ReviewDecision } from '../evaluate/decision.js';
import { review } from '../evaluate/review.js';
import type { SnapshotLoader } from '../load/rpc-loader.js';
import type { Policy } from '../policy.js';
import type { Reason } from '../reasons.js';

/** Thrown whenever the wrapper refuses to sign. The inner signer was not called, or its output was rejected. */
export class PolicyViolationError extends Error {
  constructor(
    readonly reasons: readonly Reason[],
    readonly decision?: ReviewDecision,
  ) {
    super(
      `refused to sign: ${reasons.map((r) => (r.path ? `${r.code} at ${r.path}` : r.code)).join(', ')}`,
    );
    this.name = 'PolicyViolationError';
  }
}

/** Finds the approval for a message by its digest (hex SHA-256 of the message bytes). */
export type ApprovalLookup = (
  messageDigest: string,
) => ApprovalRecord | undefined | Promise<ApprovalRecord | undefined>;

/** A Kit partial signer that is also a valid Keychain `SolanaTransactionSigner`. */
export type PolicySigner<TAddress extends string = string> = TransactionPartialSigner<TAddress> & {
  isAvailable(): Promise<boolean>;
};

export type WithPolicyOptions = {
  readonly policy: Policy;
  readonly loader: SnapshotLoader;
  readonly approvals?: ApprovalLookup;
  readonly now?: () => Date;
  readonly onDecision?: (decision: ReviewDecision) => void;
};

/** Checks that every returned signature is a valid Ed25519 signature by `signer` over the message. */
export async function checkReturnedSignatures(
  signer: Address,
  transactions: readonly Transaction[],
  returned: readonly Readonly<Record<string, SignatureBytes>>[],
): Promise<void> {
  if (returned.length !== transactions.length) {
    throw new PolicyViolationError([
      { code: 'SIGNATURE_INVALID', detail: 'wrong number of results' },
    ]);
  }
  const publicKey = await getPublicKeyFromAddress(signer);
  for (const [i, dictionary] of returned.entries()) {
    const entries = Object.entries(dictionary);
    const [only] = entries;
    const transaction = transactions[i];
    if (
      entries.length !== 1 ||
      only === undefined ||
      only[0] !== signer ||
      transaction === undefined
    ) {
      throw new PolicyViolationError([
        { code: 'SIGNATURE_INVALID', detail: `result ${i} is not one signature by ${signer}` },
      ]);
    }
    if (!(await verifySignature(publicKey, only[1], new Uint8Array(transaction.messageBytes)))) {
      throw new PolicyViolationError([
        {
          code: 'SIGNATURE_INVALID',
          detail: `result ${i} does not sign the reviewed message bytes`,
        },
      ]);
    }
  }
}

/**
 * Wraps a signer so that it signs only messages that pass review, and only with
 * a valid approval when the policy asks for one. It exposes no message signing.
 * Anyone who can reach the inner signer or its credentials bypasses this check.
 */
export function withPolicy<TAddress extends string>(
  inner: TransactionPartialSigner<TAddress> & { isAvailable?: () => Promise<boolean> },
  options: WithPolicyOptions,
): PolicySigner<TAddress> {
  if (typeof (inner as { signTransactions?: unknown }).signTransactions !== 'function') {
    throw new PolicyViolationError([
      {
        code: 'UNSUPPORTED_INNER_SIGNER',
        detail: 'the inner signer cannot partially sign transactions',
      },
    ]);
  }
  if (inner.address !== options.policy.signer) {
    throw new PolicyViolationError([
      { code: 'SIGNER_ADDRESS_MISMATCH', detail: `${inner.address} is not the policy signer` },
    ]);
  }
  const { policy, loader, approvals, onDecision } = options;
  const now = options.now ?? (() => new Date());

  return {
    address: inner.address,
    async isAvailable() {
      return inner.isAvailable === undefined ? true : inner.isAvailable();
    },
    async signTransactions(transactions, config) {
      // Review every transaction from scratch before the inner signer sees any of them.
      for (const transaction of transactions) {
        const messageBytes = new Uint8Array(transaction.messageBytes);
        const snapshot = await loader.load(messageBytes, { network: policy.network });
        const decision = await review({ messageBytes, policy, snapshot, now: now() });
        onDecision?.(decision);
        if (decision.outcome === 'deny') throw new PolicyViolationError(decision.reasons, decision);
        if (decision.outcome === 'needs_approval') {
          const record = await approvals?.(decision.messageDigest);
          if (record === undefined) {
            throw new PolicyViolationError([{ code: 'APPROVAL_REQUIRED' }], decision);
          }
          const problems = await verifyApproval(record, { messageBytes, policy, now: now() });
          if (problems.length > 0) throw new PolicyViolationError(problems, decision);
        }
      }
      const signed = await inner.signTransactions(transactions, config);
      await checkReturnedSignatures(inner.address, transactions, signed);
      return signed;
    },
  };
}
