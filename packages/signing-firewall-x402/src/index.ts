// Glue between Signing Firewall for Solana and the @x402 packages. The core
// library never imports @x402; everything that does lives here.
import { getTransactionDecoder, getBase64Encoder } from '@solana/kit';
import type { PaymentPolicy } from '@x402/core/client';
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { type ClientSvmConfig, findDefaultAsset } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';

import {
  type PolicyNetwork,
  type SnapshotLoader,
  type X402Guard,
  type X402QuoteDecision,
  type X402VerifierConfig,
  type X402VerifierDecision,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';

/** Prefix of the reason a wrapped facilitator returns when our verifier refuses a payment. */
export const REASON_PREFIX = 'solana-signing-firewall:';

/**
 * A policy for `x402Client.registerPolicy()` that keeps only the options the
 * guard allows. When none is left, the payment fails before any transaction exists.
 */
export function x402RequirementsFilter(
  guard: X402Guard,
  onDecisions?: (decisions: readonly X402QuoteDecision[]) => void,
): PaymentPolicy {
  return (_x402Version, requirements) => {
    const decisions = guard.checkRequirements(requirements);
    onDecisions?.(decisions);
    return requirements.filter((_, i) => decisions[i]?.outcome === 'allow');
  };
}

/**
 * The `@x402/svm` exact client, paying through a single-use signer the guard binds
 * to the accepted option. The SDK builds the transaction; the bound signer checks
 * the bytes it is asked to sign against that option before the key signs.
 */
export class GuardedExactSvmScheme implements SchemeNetworkClient {
  readonly scheme = 'exact';
  readonly findDefaultAsset = findDefaultAsset;

  constructor(
    private readonly guard: X402Guard,
    private readonly config?: ClientSvmConfig,
  ) {}

  createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    const signer = this.guard.signerFor(requirements);
    return new ExactSvmScheme(signer, this.config).createPaymentPayload(x402Version, requirements);
  }
}

type Refusal = { reason: string; message: string; decision: X402VerifierDecision };

/**
 * Wraps a facilitator scheme (for example `@x402/svm`'s `ExactSvmScheme`) so our
 * verifier runs first. `verify` returns invalid without calling the inner verify
 * when it finds any reason; `settle` runs the verifier again from scratch before
 * it delegates.
 */
export function withX402Verifier(
  inner: SchemeNetworkFacilitator,
  options: {
    readonly config: X402VerifierConfig;
    readonly loader: SnapshotLoader;
    /** The cluster the loader's RPC must serve (checked against its genesis hash). */
    readonly network: PolicyNetwork;
    readonly now?: () => Date;
    readonly onDecision?: (decision: X402VerifierDecision) => void;
  },
): SchemeNetworkFacilitator {
  const now = options.now ?? (() => new Date());

  async function check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<Refusal | undefined> {
    const transaction = (payload.payload as { transaction?: unknown }).transaction;
    let messageBytes = new Uint8Array();
    if (typeof transaction === 'string') {
      try {
        messageBytes = new Uint8Array(
          getTransactionDecoder().decode(getBase64Encoder().encode(transaction)).messageBytes,
        );
      } catch {
        messageBytes = new Uint8Array();
      }
    }
    const snapshot = await options.loader.load(messageBytes, { network: options.network });
    const decision = await verifyX402Payment({
      transaction: typeof transaction === 'string' ? transaction : '',
      requirements,
      config: options.config,
      snapshot,
      now: now(),
    });
    options.onDecision?.(decision);
    if (decision.outcome === 'valid') return undefined;
    const codes = decision.reasons.map((r) => r.code);
    return {
      reason: `${REASON_PREFIX}${codes[0] ?? 'UNKNOWN'}`,
      message: codes.join(', '),
      decision,
    };
  }

  const wrapped: SchemeNetworkFacilitator = {
    scheme: inner.scheme,
    caipFamily: inner.caipFamily,
    getExtra: (network) => {
      const extra = inner.getExtra(network);
      if (extra === undefined) return undefined;
      // Advertise only versions the verifier accepts: the inner scheme's own list (version 0
      // when it has none, as the spec reads an absent field), narrowed to the config's.
      const accepted: readonly number[] = options.config.messageVersions.flatMap((v) =>
        v === 'v0' ? [0] : v === 'v1' ? [1] : [],
      );
      const offered: unknown[] = Array.isArray(extra.transactionVersions)
        ? (extra.transactionVersions as unknown[])
        : [0];
      return {
        ...extra,
        transactionVersions: offered.filter(
          (v): v is number => typeof v === 'number' && accepted.includes(v),
        ),
      };
    },
    getSigners: (network) => inner.getSigners(network),
    async verify(payload, requirements, context): Promise<VerifyResponse> {
      const refusal = await check(payload, requirements);
      if (refusal !== undefined) {
        return {
          isValid: false,
          invalidReason: refusal.reason,
          invalidMessage: refusal.message,
          ...(refusal.decision.payer === undefined ? {} : { payer: refusal.decision.payer }),
        };
      }
      return inner.verify(payload, requirements, context);
    },
    async settle(payload, requirements, context): Promise<SettleResponse> {
      const refusal = await check(payload, requirements);
      if (refusal !== undefined) {
        return {
          success: false,
          errorReason: refusal.reason,
          errorMessage: refusal.message,
          transaction: '',
          network: requirements.network,
          ...(refusal.decision.payer === undefined ? {} : { payer: refusal.decision.payer }),
        };
      }
      return inner.settle(payload, requirements, context);
    },
  };
  return wrapped;
}
