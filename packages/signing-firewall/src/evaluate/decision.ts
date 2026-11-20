import type { Address } from '@solana/kit';

import type { LookupTableEntry, MessageVersion, Transfer } from '../decode/types.js';
import type { Reason } from '../reasons.js';

export type Outcome = 'allow' | 'needs_approval' | 'deny';

export type ReviewedTransfer = Transfer & {
  /** Owner of the destination token account, from the snapshot, when known. */
  readonly destinationOwner: Address | undefined;
};

export type FeeSummary = {
  readonly source: 'instructions' | 'transactionConfig';
  /** The explicit limit, or undefined when the message sets none. */
  readonly computeUnitLimit: number | undefined;
  /** Legacy and v0 only. */
  readonly computeUnitPriceMicroLamports: bigint | undefined;
  /**
   * Total priority fee. Legacy and v0: ceil(limit x price / 1,000,000), using
   * 1,400,000 units when the message sets no limit. v1: from transactionConfig.
   */
  readonly priorityFeeLamports: bigint;
  /** v1 only. */
  readonly loadedAccountsDataSizeLimit: number | undefined;
  /** v1 only. */
  readonly heapSize: number | undefined;
};

export type ReviewDecision = {
  readonly outcome: Outcome;
  /** Every failing check, not only the first. Empty unless the outcome is `deny`. */
  readonly reasons: readonly Reason[];
  /** SHA-256 of the message bytes, hex. */
  readonly messageDigest: string;
  /** SHA-256 of the RFC 8785 canonical JSON of the policy file, hex. */
  readonly policyDigest: string;
  readonly policyId: string;
  /** Undefined when the message did not decode. */
  readonly version: MessageVersion | undefined;
  readonly feePayer: Address | undefined;
  readonly requiredSigners: readonly Address[];
  readonly lifetime: { readonly type: 'blockhash' | 'nonce'; readonly token: string } | undefined;
  readonly transfers: readonly ReviewedTransfer[];
  readonly totals: readonly { readonly mint: Address; readonly amount: bigint }[];
  readonly fees: FeeSummary | undefined;
  readonly lookupTableEntries: readonly LookupTableEntry[];
  readonly snapshotSlot: bigint;
};

const stringify = (value: bigint | undefined) => (value === undefined ? null : value.toString());

/** JSON form of a decision (bigints as decimal strings), for logs and recorded runs. */
export function decisionToJson(decision: ReviewDecision) {
  return {
    outcome: decision.outcome,
    reasons: decision.reasons.map((reason) => ({ ...reason })),
    messageDigest: decision.messageDigest,
    policyDigest: decision.policyDigest,
    policyId: decision.policyId,
    version: decision.version ?? null,
    feePayer: decision.feePayer ?? null,
    requiredSigners: [...decision.requiredSigners],
    lifetime: decision.lifetime ?? null,
    transfers: decision.transfers.map((t) => ({
      path: t.path,
      mint: t.mint,
      amount: t.amount.toString(),
      decimals: t.decimals,
      source: t.source,
      destination: t.destination,
      destinationOwner: t.destinationOwner ?? null,
      authority: t.authority,
    })),
    totals: decision.totals.map((t) => ({ mint: t.mint, amount: t.amount.toString() })),
    fees:
      decision.fees === undefined
        ? null
        : {
            source: decision.fees.source,
            computeUnitLimit: decision.fees.computeUnitLimit ?? null,
            computeUnitPriceMicroLamports: stringify(decision.fees.computeUnitPriceMicroLamports),
            priorityFeeLamports: decision.fees.priorityFeeLamports.toString(),
            loadedAccountsDataSizeLimit: decision.fees.loadedAccountsDataSizeLimit ?? null,
            heapSize: decision.fees.heapSize ?? null,
          },
    lookupTableEntries: decision.lookupTableEntries.map((e) => ({ ...e })),
    snapshotSlot: decision.snapshotSlot.toString(),
  };
}
