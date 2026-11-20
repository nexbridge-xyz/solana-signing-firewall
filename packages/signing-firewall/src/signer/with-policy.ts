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

/**
 * One transaction as the wrapper holds it after its single look at the caller's input.
 *
 * The caller keeps references to the objects it passed to `signTransactions()` and can change
 * them while the wrapper awaits the snapshot, the review, an approval or a budget reservation.
 * So the wrapper reads each caller object exactly once, synchronously, and never again.
 */
export type HeldTransaction = {
  /** The wrapper's own copy of the message bytes: reviewed, approved, and checked against the signature. */
  readonly messageBytes: Uint8Array;
  /** What the inner signer receives: a second copy, so a signer that edits its input cannot change ours. */
  readonly forSigner: SignableTransaction;
};

/** A transaction as Kit hands it to a partial signer. */
type SignableTransaction = Parameters<TransactionPartialSigner['signTransactions']>[0][number];

/** Copies the caller's transactions. Call it before the first `await`. */
export function holdTransactions(transactions: readonly Transaction[]): HeldTransaction[] {
  return Array.from(transactions, (transaction) => {
    // One read of each field; a getter cannot answer differently later.
    const {
      messageBytes: given,
      signatures,
      lifetimeConstraint,
    } = transaction as Transaction & { readonly lifetimeConstraint?: unknown };
    const messageBytes = new Uint8Array(given);
    const forSigner = Object.freeze({
      messageBytes: new Uint8Array(messageBytes),
      signatures: Object.freeze({ ...signatures }),
      ...(typeof lifetimeConstraint === 'object' && lifetimeConstraint !== null
        ? { lifetimeConstraint: Object.freeze({ ...lifetimeConstraint }) }
        : {}),
    }) as unknown as SignableTransaction;
    return { messageBytes, forSigner };
  });
}

/**
 * Checks that every result is exactly one valid Ed25519 signature by `signer` over the reviewed
 * message bytes, and returns those signatures in fresh dictionaries.
 */
export async function checkReturnedSignatures(
  signer: Address,
  reviewedMessages: readonly Uint8Array[],
  returned: readonly Readonly<Record<string, SignatureBytes>>[],
): Promise<Readonly<Record<Address, SignatureBytes>>[]> {
  if (returned.length !== reviewedMessages.length) {
    throw new PolicyViolationError([
      { code: 'SIGNATURE_INVALID', detail: 'wrong number of results' },
    ]);
  }
  const publicKey = await getPublicKeyFromAddress(signer);
  const verified: Readonly<Record<Address, SignatureBytes>>[] = [];
  for (const [i, dictionary] of returned.entries()) {
    const entries = Object.entries(dictionary);
    const [only] = entries;
    const messageBytes = reviewedMessages[i];
    if (
      entries.length !== 1 ||
      only === undefined ||
      only[0] !== signer ||
      messageBytes === undefined
    ) {
      throw new PolicyViolationError([
        { code: 'SIGNATURE_INVALID', detail: `result ${i} is not one signature by ${signer}` },
      ]);
    }
    const signature = new Uint8Array(only[1]) as SignatureBytes;
    if (!(await verifySignature(publicKey, signature, messageBytes))) {
      throw new PolicyViolationError([
        {
          code: 'SIGNATURE_INVALID',
          detail: `result ${i} does not sign the reviewed message bytes`,
        },
      ]);
    }
    verified.push(Object.freeze({ [signer]: signature }));
  }
  return verified;
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
      // Before the first await: take our own copies. The caller's objects are not read again.
      const held = holdTransactions(transactions);
      // Review every transaction from scratch before the inner signer sees any of them.
      for (const { messageBytes } of held) {
        const snapshot = await loader.load(new Uint8Array(messageBytes), {
          network: policy.network,
        });
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
      const signed = await inner.signTransactions(
        held.map((h) => h.forSigner),
        config,
      );
      return checkReturnedSignatures(
        inner.address,
        held.map((h) => h.messageBytes),
        signed,
      );
    },
  };
}
