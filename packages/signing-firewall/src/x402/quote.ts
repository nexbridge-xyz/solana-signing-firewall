import type { Policy, X402PolicyBlock } from '../policy.js';
import type { Reason } from '../reasons.js';
import type { BudgetLedger, LedgerUsage } from './ledger.js';
import { limitReasons } from './ledger.js';
import { type X402Requirements, parseRequirements, requirementsDigest } from './requirements.js';

export type X402QuoteDecision = {
  /** Position of the option in the list the server sent. */
  readonly index: number;
  readonly outcome: 'allow' | 'deny';
  readonly reasons: readonly Reason[];
  /** SHA-256 of the RFC 8785 canonical JSON of the option as received. */
  readonly requirementsDigest: string;
  readonly requirements: X402Requirements | undefined;
  readonly usage: LedgerUsage | undefined;
};

const VERSION_NAMES = { 0: 'v0', 1: 'v1' } as const;

/** The digest of an option; '' when it is not JSON-serializable at all. */
export function safeDigest(json: unknown): string {
  try {
    return requirementsDigest(json);
  } catch {
    return '';
  }
}

/** The quote-level checks of the guard, before any transaction exists. */
export function checkQuote(
  json: unknown,
  index: number,
  context: {
    readonly policy: Policy & { readonly x402: X402PolicyBlock };
    readonly ledger: BudgetLedger;
    readonly now: Date;
  },
): X402QuoteDecision {
  const digest = safeDigest(json);
  const parsed = parseRequirements(json);
  if (!parsed.ok) {
    return {
      index,
      outcome: 'deny',
      reasons: [parsed.reason],
      requirementsDigest: digest,
      requirements: undefined,
      usage: undefined,
    };
  }
  const r = parsed.value;
  const { policy } = context;
  const x402 = policy.x402;
  const reasons: Reason[] = [];

  if (!(x402.schemes as readonly string[]).includes(r.scheme))
    reasons.push({ code: 'X402_SCHEME_NOT_ALLOWED', detail: r.scheme });
  if (!x402.networks.includes(r.network))
    reasons.push({ code: 'X402_NETWORK_NOT_ALLOWED', detail: r.network });
  const rule = policy.mints.get(r.asset);
  if (rule === undefined) reasons.push({ code: 'X402_ASSET_NOT_ALLOWED', account: r.asset });
  if (!policy.recipients.owners.includes(r.payTo))
    reasons.push({ code: 'X402_PAYTO_NOT_ALLOWED', account: r.payTo });
  if (
    r.feePayer === undefined ||
    !policy.feePayers.includes(r.feePayer) ||
    r.feePayer === policy.signer
  ) {
    reasons.push({
      code: 'X402_FEE_PAYER_NOT_ALLOWED',
      ...(r.feePayer === undefined
        ? { detail: 'extra.feePayer is missing' }
        : { account: r.feePayer }),
    });
  }
  if (r.amount === 0n) reasons.push({ code: 'ZERO_AMOUNT' });
  if (rule !== undefined && r.amount > rule.maxPerTransaction) {
    reasons.push({
      code: 'X402_PER_PAYMENT_LIMIT_EXCEEDED',
      detail: `${r.amount} > ${rule.maxPerTransaction}`,
    });
  }
  if (rule?.approvalAbove !== undefined && r.amount > rule.approvalAbove) {
    // x402 payments never wait for a person.
    reasons.push({
      code: 'APPROVAL_REQUIRED',
      detail: 'x402 payments cannot wait for an approval',
    });
  }
  if (r.maxTimeoutSeconds > x402.maxTimeoutSeconds) {
    reasons.push({
      code: 'X402_TIMEOUT_OUT_OF_RANGE',
      detail: `${r.maxTimeoutSeconds} > ${x402.maxTimeoutSeconds}`,
    });
  }
  if (r.splitCount > 0)
    reasons.push({ code: 'X402_SPLITS_NOT_ALLOWED', detail: `${r.splitCount} splits` });
  if (r.ataCreationRequired) reasons.push({ code: 'X402_CREATE_ATA_NOT_ALLOWED' });
  if (!r.transactionVersions.some((v) => policy.messageVersions.includes(VERSION_NAMES[v]))) {
    reasons.push({
      code: 'VERSION_NOT_ALLOWED',
      detail: `advertised ${JSON.stringify(r.transactionVersions)}`,
    });
  }

  const usage = context.ledger.usage(r.asset, context.now);
  const budget = x402.budgets.get(r.asset);
  if (rule === undefined) {
    // The asset is refused already; its budget does not matter.
  } else if (budget === undefined) {
    reasons.push({
      code: 'X402_BUDGET_EXCEEDED',
      detail: 'the policy sets no daily budget for this asset',
    });
  } else {
    reasons.push(
      ...limitReasons(usage, r.amount, {
        maxPerDay: budget.maxPerDay,
        maxPaymentsPerMinute: x402.maxPaymentsPerMinute,
      }),
    );
  }

  return {
    index,
    outcome: reasons.length === 0 ? 'allow' : 'deny',
    reasons,
    requirementsDigest: digest,
    requirements: r,
    usage,
  };
}
