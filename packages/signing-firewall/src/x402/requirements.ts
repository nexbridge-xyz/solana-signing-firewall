// x402 payment requirements, defined here with their own schema so the core
// library never imports @x402. The shape follows x402 v2 PaymentRequirements
// and the Solana `exact` scheme's `extra` fields.
import { type Address, isAddress } from '@solana/kit';

import { canonicalDigest } from '../canonical.js';
import type { Reason } from '../reasons.js';

const U64_MAX = 0xffff_ffff_ffff_ffffn;
/** The spec's limit for a seller-defined memo. */
export const MAX_SELLER_MEMO_BYTES = 256;

export type X402Requirements = {
  readonly scheme: string;
  /** CAIP-2 network ID. */
  readonly network: string;
  readonly asset: Address;
  readonly amount: bigint;
  readonly payTo: Address;
  readonly maxTimeoutSeconds: number;
  readonly feePayer: Address | undefined;
  /** Seller-defined memo text, when the quote sets one. */
  readonly memo: string | undefined;
  /** Number of `extra.splits` entries (0 when absent). */
  readonly splitCount: number;
  readonly ataCreationRequired: boolean;
  /** `extra.transactionVersions`; the spec reads absence as [0]. */
  readonly transactionVersions: readonly (0 | 1)[];
  /** The option as received. Its canonical JSON digest identifies the quote. */
  readonly json: unknown;
};

type Parsed = { ok: true; value: X402Requirements } | { ok: false; reason: Reason };

const malformed = (detail: string): Parsed => ({
  ok: false,
  reason: { code: 'X402_REQUIREMENTS_MALFORMED', detail },
});

/** Validates one payment option. Unknown `extra` fields are kept and ignored. */
export function parseRequirements(json: unknown): Parsed {
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return malformed('not an object');
  const r = json as Record<string, unknown>;
  for (const key of ['scheme', 'network', 'asset', 'amount', 'payTo'] as const) {
    if (typeof r[key] !== 'string' || r[key] === '')
      return malformed(`${key} must be a non-empty string`);
  }
  const { scheme, network, asset, amount, payTo } = r as Record<string, string>;
  if (
    scheme === undefined ||
    network === undefined ||
    asset === undefined ||
    amount === undefined ||
    payTo === undefined
  ) {
    return malformed('missing field');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) > U64_MAX) {
    return malformed('amount must be a decimal string of base units within u64');
  }
  if (!isAddress(asset)) return malformed('asset is not an address');
  if (!isAddress(payTo)) return malformed('payTo is not an address');
  const timeout = r.maxTimeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
    return malformed('maxTimeoutSeconds must be a positive integer');
  }

  const extra: unknown = r.extra ?? {};
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra))
    return malformed('extra must be an object');
  const e = extra as Record<string, unknown>;
  if (e.feePayer !== undefined && (typeof e.feePayer !== 'string' || !isAddress(e.feePayer))) {
    return malformed('extra.feePayer is not an address');
  }
  if (e.memo !== undefined) {
    if (typeof e.memo !== 'string') return malformed('extra.memo must be a string');
    if (new TextEncoder().encode(e.memo).length > MAX_SELLER_MEMO_BYTES) {
      return malformed(`extra.memo exceeds ${MAX_SELLER_MEMO_BYTES} bytes`);
    }
  }
  if (e.splits !== undefined && !Array.isArray(e.splits))
    return malformed('extra.splits must be an array');
  if (e.ataCreationRequired !== undefined && typeof e.ataCreationRequired !== 'boolean') {
    return malformed('extra.ataCreationRequired must be a boolean');
  }
  let transactionVersions: (0 | 1)[] = [0];
  if (e.transactionVersions !== undefined) {
    // The spec: entries must be the JSON integers 0 or 1; anything else fails closed.
    if (
      !Array.isArray(e.transactionVersions) ||
      e.transactionVersions.some((v) => v !== 0 && v !== 1)
    ) {
      return malformed('extra.transactionVersions must contain only 0 and 1');
    }
    transactionVersions = e.transactionVersions as (0 | 1)[];
  }

  return {
    ok: true,
    value: {
      scheme,
      network,
      asset,
      amount: BigInt(amount),
      payTo,
      maxTimeoutSeconds: timeout,
      feePayer: e.feePayer,
      memo: e.memo,
      splitCount: Array.isArray(e.splits) ? e.splits.length : 0,
      ataCreationRequired: e.ataCreationRequired === true,
      transactionVersions,
      json,
    },
  };
}

/** SHA-256 (hex) of the RFC 8785 canonical JSON of one payment option as received. */
export function requirementsDigest(json: unknown): string {
  return canonicalDigest(json);
}
