import type { Address, TransactionPartialSigner } from '@solana/kit';

import { decodeTransactionMessage } from '../decode/index.js';
import type { ReviewDecision } from '../evaluate/decision.js';
import { review } from '../evaluate/review.js';
import type { SnapshotLoader } from '../load/rpc-loader.js';
import type { Policy, X402PolicyBlock } from '../policy.js';
import type { Reason } from '../reasons.js';
import type { Snapshot } from '../snapshot.js';
import { PolicyViolationError, checkReturnedSignatures } from '../signer/with-policy.js';
import type { BudgetLedger, LedgerUsage } from './ledger.js';
import { type X402QuoteDecision, checkQuote } from './quote.js';
import { bindingReasons, guardMemoReasons, paymentShape } from './shape.js';

export type X402PaymentDecision = ReviewDecision & {
  readonly x402: {
    readonly requirementsDigest: string;
    readonly network: string | undefined;
    readonly payee: Address | undefined;
    readonly asset: Address | undefined;
    readonly amount: bigint | undefined;
    readonly feePayer: Address | undefined;
    readonly ledger: LedgerUsage | undefined;
  };
};

type X402Policy = Policy & { readonly x402: X402PolicyBlock };

/**
 * Reviews the bytes the bound signer is asked to sign for one accepted option:
 * everything review() checks, the quote checks again, then the binding checks.
 * Collects every failing reason.
 */
export async function reviewX402Payment(input: {
  readonly messageBytes: Uint8Array;
  readonly requirements: unknown;
  readonly policy: X402Policy;
  readonly snapshot: Snapshot;
  readonly ledger: BudgetLedger;
  readonly now: Date;
}): Promise<X402PaymentDecision> {
  const { messageBytes, policy, snapshot, now } = input;
  const base = await review({ messageBytes, policy, snapshot, now });
  const quote = checkQuote(input.requirements, 0, { policy, ledger: input.ledger, now });
  const reasons: Reason[] = [...base.reasons, ...quote.reasons];

  const requirements = quote.requirements;
  const decoded = decodeTransactionMessage(messageBytes, snapshot);
  if (requirements !== undefined && decoded.ok) {
    const shape = paymentShape(decoded.value);
    reasons.push(
      ...(await bindingReasons(decoded.value, shape, requirements, {
        maxComputeUnitPriceMicroLamports: policy.x402.maxComputeUnitPriceMicroLamports,
      })),
      ...guardMemoReasons(shape, requirements),
    );
  }

  const unique = dedupe(reasons);
  return {
    ...base,
    outcome: unique.length > 0 ? 'deny' : base.outcome,
    reasons: unique,
    x402: {
      requirementsDigest: quote.requirementsDigest,
      network: requirements?.network,
      payee: requirements?.payTo,
      asset: requirements?.asset,
      amount: requirements?.amount,
      feePayer: requirements?.feePayer,
      ledger: quote.usage,
    },
  };
}

function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.code}|${r.path ?? ''}|${r.account ?? ''}|${r.program ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type X402Guard = {
  /** One decision per option. Only `allow` options may be paid. */
  checkRequirements(options: readonly unknown[]): X402QuoteDecision[];
  /** A single-use signer bound to one option. It signs at most one transaction. */
  signerFor(requirements: unknown): TransactionPartialSigner;
};

export type CreateX402GuardOptions = {
  readonly inner: TransactionPartialSigner;
  readonly policy: Policy;
  readonly loader: SnapshotLoader;
  readonly ledger: BudgetLedger;
  readonly now?: () => Date;
  readonly onDecision?: (decision: X402QuoteDecision | X402PaymentDecision) => void;
};

/**
 * Gives an agent a signer that pays only the quote it accepted, checked byte
 * for byte, within per-payment and daily limits. The reservation is made just
 * before the inner signer is called and is never released in v0.1.0.
 */
export function createX402Guard(options: CreateX402GuardOptions): X402Guard {
  const { inner, loader, ledger, onDecision } = options;
  const now = options.now ?? (() => new Date());
  if (typeof (inner as { signTransactions?: unknown }).signTransactions !== 'function') {
    throw new PolicyViolationError([{ code: 'UNSUPPORTED_INNER_SIGNER' }]);
  }
  if (inner.address !== options.policy.signer) {
    throw new PolicyViolationError([
      { code: 'SIGNER_ADDRESS_MISMATCH', detail: `${inner.address} is not the policy signer` },
    ]);
  }
  const x402 = options.policy.x402;
  if (x402 === undefined) throw new Error('the policy has no "x402" section');
  const policy: X402Policy = { ...options.policy, x402 };

  return {
    checkRequirements(list) {
      const decisions: X402QuoteDecision[] = [];
      for (const [index, json] of list.entries()) {
        const decision = checkQuote(json, index, { policy, ledger, now: now() });
        onDecision?.(decision);
        decisions.push(decision);
      }
      return decisions;
    },

    signerFor(requirements) {
      let used = false;
      return {
        address: inner.address,
        async signTransactions(transactions, config) {
          if (used) throw new PolicyViolationError([{ code: 'X402_SIGNER_ALREADY_USED' }]);
          used = true;
          const [transaction] = transactions;
          if (transaction === undefined || transactions.length !== 1) {
            throw new PolicyViolationError([
              { code: 'X402_LAYOUT_INVALID', detail: 'expected exactly one transaction' },
            ]);
          }
          const messageBytes = new Uint8Array(transaction.messageBytes);
          const at = now();
          const snapshot = await loader.load(messageBytes, { network: policy.network });
          const decision = await reviewX402Payment({
            messageBytes,
            requirements,
            policy,
            snapshot,
            ledger,
            now: at,
          });
          onDecision?.(decision);
          if (decision.outcome !== 'allow') {
            throw new PolicyViolationError(
              decision.outcome === 'needs_approval'
                ? [{ code: 'APPROVAL_REQUIRED' }]
                : decision.reasons,
              decision,
            );
          }
          const { asset, amount, payee } = decision.x402;
          const budget = asset === undefined ? undefined : policy.x402.budgets.get(asset);
          if (
            asset === undefined ||
            amount === undefined ||
            payee === undefined ||
            budget === undefined
          ) {
            throw new PolicyViolationError([{ code: 'X402_BUDGET_EXCEEDED' }], decision);
          }
          const refused = await ledger.reserve(
            {
              time: at.toISOString(),
              mint: asset,
              amount,
              payee,
              requirementsDigest: decision.x402.requirementsDigest,
              messageDigest: decision.messageDigest,
            },
            { maxPerDay: budget.maxPerDay, maxPaymentsPerMinute: policy.x402.maxPaymentsPerMinute },
            at,
          );
          if (refused.length > 0) throw new PolicyViolationError(refused, decision);
          const signed = await inner.signTransactions(transactions, config);
          await checkReturnedSignatures(inner.address, transactions, signed);
          return signed;
        },
      };
    },
  };
}
