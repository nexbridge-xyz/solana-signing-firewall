import {
  type Address,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isAddress,
  verifySignature,
} from '@solana/kit';

import { sha256Hex } from '../canonical.js';
import { decodeTransactionMessage } from '../decode/index.js';
import type { MessageVersion } from '../decode/types.js';
import type { Reason } from '../reasons.js';
import type { Snapshot } from '../snapshot.js';
import { safeDigest } from './quote.js';
import { parseRequirements } from './requirements.js';
import { bindingReasons, paymentShape, verifierMemoReasons } from './shape.js';

export const X402_VERIFIER_SCHEMA = 'solana-signing-firewall.x402-verifier/v0';
const ASSUMED_COMPUTE_UNIT_LIMIT = 1_400_000n;

export type X402VerifierConfig = {
  readonly networks: readonly string[];
  readonly feePayers: readonly Address[];
  readonly messageVersions: readonly MessageVersion[];
  readonly assets: ReadonlyMap<Address, { readonly decimals: number }>;
  readonly maxComputeUnitLimit: number;
  readonly maxComputeUnitPriceMicroLamports: bigint;
  readonly maxPriorityFeeLamports: bigint;
  readonly maxRequiredSignatures: number;
  readonly durableNonce: 'deny';
  readonly createRecipientAccount: 'deny';
  readonly lookupTables: 'deny';
};

export class VerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierConfigError';
  }
}

const KEYS = [
  'schema',
  'networks',
  'feePayers',
  'messageVersions',
  'assets',
  'maxComputeUnitLimit',
  'maxComputeUnitPriceMicroLamports',
  'maxPriorityFeeLamports',
  'maxRequiredSignatures',
  'durableNonce',
  'createRecipientAccount',
  'lookupTables',
];

function fail(message: string): never {
  throw new VerifierConfigError(`x402 verifier config: ${message}`);
}

const amount = (value: unknown, name: string) =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : fail(`${name} must be a decimal string`);

/** Validates a verifier config. Unknown fields are rejected; the `deny` switches default to `deny`. */
export function parseVerifierConfig(json: unknown): X402VerifierConfig {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('must be an object');
  const c = json as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!KEYS.includes(key)) fail(`unknown field ${key}`);
  if (c.schema !== X402_VERIFIER_SCHEMA) fail(`schema must be "${X402_VERIFIER_SCHEMA}"`);
  const list = (value: unknown, name: string): string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v): v is string => typeof v === 'string')
      ? value
      : fail(`${name} must be a non-empty array of strings`);
  const feePayers = list(c.feePayers, 'feePayers').map((a) =>
    isAddress(a) ? a : fail(`feePayers: ${a} is not an address`),
  );
  const messageVersions = list(c.messageVersions, 'messageVersions').map((v) =>
    v === 'v0' || v === 'v1' ? v : fail(`messageVersions: ${v} is not "v0" or "v1"`),
  );
  if (typeof c.assets !== 'object' || c.assets === null || Array.isArray(c.assets)) {
    fail('assets must be an object');
  }
  const assets = new Map<Address, { decimals: number }>();
  for (const [mint, rule] of Object.entries(c.assets as Record<string, unknown>)) {
    const decimals =
      typeof rule === 'object' && rule !== null
        ? (rule as { decimals?: unknown }).decimals
        : undefined;
    if (
      !isAddress(mint) ||
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    ) {
      fail(`assets.${mint} is invalid`);
    }
    assets.set(mint, { decimals });
  }
  if (assets.size === 0) fail('assets must name at least one mint');
  const integer = (value: unknown, name: string) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : fail(`${name} must be a positive integer`);
  const deny = (value: unknown, name: string): 'deny' =>
    value === undefined || value === 'deny' ? 'deny' : fail(`${name} must be "deny"`);
  return {
    networks: list(c.networks, 'networks'),
    feePayers,
    messageVersions,
    assets,
    maxComputeUnitLimit: integer(c.maxComputeUnitLimit, 'maxComputeUnitLimit'),
    maxComputeUnitPriceMicroLamports: amount(
      c.maxComputeUnitPriceMicroLamports,
      'maxComputeUnitPriceMicroLamports',
    ),
    maxPriorityFeeLamports: amount(c.maxPriorityFeeLamports, 'maxPriorityFeeLamports'),
    maxRequiredSignatures: integer(c.maxRequiredSignatures, 'maxRequiredSignatures'),
    durableNonce: deny(c.durableNonce, 'durableNonce'),
    createRecipientAccount: deny(c.createRecipientAccount, 'createRecipientAccount'),
    lookupTables: deny(c.lookupTables, 'lookupTables'),
  };
}

export type X402VerifierDecision = {
  readonly outcome: 'valid' | 'invalid';
  readonly reasons: readonly Reason[];
  readonly messageDigest: string | undefined;
  readonly requirementsDigest: string;
  /** The buyer: the transfer authority. */
  readonly payer: Address | undefined;
  readonly amount: bigint | undefined;
  readonly version: MessageVersion | undefined;
  readonly snapshotSlot: bigint;
};

/**
 * Checks an x402 `exact` payment independently, before a facilitator signs or
 * settles it. Pure: no network calls. Any buyer may pay; there is no policy signer.
 */
export async function verifyX402Payment(input: {
  /** The partially signed wire transaction, base64, as in `PaymentPayload.payload.transaction`. */
  readonly transaction: string;
  readonly requirements: unknown;
  readonly config: X402VerifierConfig;
  readonly snapshot: Snapshot;
  readonly now: Date;
}): Promise<X402VerifierDecision> {
  const { config, snapshot } = input;
  const reasons: Reason[] = [];
  const digest = safeDigest(input.requirements);
  const result = (extra: Partial<X402VerifierDecision> = {}): X402VerifierDecision => ({
    outcome: reasons.length === 0 ? 'valid' : 'invalid',
    reasons,
    messageDigest: undefined,
    requirementsDigest: digest,
    payer: undefined,
    amount: undefined,
    version: undefined,
    snapshotSlot: snapshot.slot,
    ...extra,
  });

  const parsed = parseRequirements(input.requirements);
  if (!parsed.ok) {
    reasons.push(parsed.reason);
    return result();
  }
  const r = parsed.value;
  if (r.scheme !== 'exact') reasons.push({ code: 'X402_SCHEME_NOT_ALLOWED', detail: r.scheme });
  if (!config.networks.includes(r.network))
    reasons.push({ code: 'X402_NETWORK_NOT_ALLOWED', detail: r.network });
  const asset = config.assets.get(r.asset);
  if (asset === undefined) reasons.push({ code: 'X402_ASSET_NOT_ALLOWED', account: r.asset });
  if (r.feePayer === undefined || !config.feePayers.includes(r.feePayer)) {
    reasons.push({
      code: 'X402_FEE_PAYER_NOT_ALLOWED',
      ...(r.feePayer === undefined ? {} : { account: r.feePayer }),
    });
  }
  if (r.amount === 0n) reasons.push({ code: 'ZERO_AMOUNT' });
  if (r.splitCount > 0) reasons.push({ code: 'X402_SPLITS_NOT_ALLOWED' });

  let wire: ReturnType<ReturnType<typeof getTransactionDecoder>['decode']>;
  try {
    wire = getTransactionDecoder().decode(getBase64Encoder().encode(input.transaction));
  } catch {
    reasons.push({ code: 'MALFORMED_MESSAGE', detail: 'the transaction does not decode' });
    return result();
  }
  const messageBytes = new Uint8Array(wire.messageBytes);
  const messageDigest = sha256Hex(messageBytes);
  const decoded = decodeTransactionMessage(messageBytes, snapshot);
  if (!decoded.ok) {
    reasons.push(...decoded.reasons);
    return result({ messageDigest, version: decoded.version });
  }
  const m = decoded.value;
  if (!config.messageVersions.includes(m.version))
    reasons.push({ code: 'VERSION_NOT_ALLOWED', detail: m.version });

  const shape = paymentShape(m);
  reasons.push(
    ...(await bindingReasons(m, shape, r, {
      maxComputeUnitPriceMicroLamports: config.maxComputeUnitPriceMicroLamports,
      feePayers: config.feePayers,
    })),
    ...verifierMemoReasons(shape, r),
  );
  if (shape.token?.program === 'token-2022')
    reasons.push({ code: 'TOKEN_PROGRAM_NOT_ALLOWED', path: shape.token.path });
  if (m.instructions.some((ix) => ix.program === 'system' && ix.advancesNonce)) {
    reasons.push({ code: 'DURABLE_NONCE_NOT_ALLOWED' });
  }

  // Compute budget and the total priority fee (stricter than the spec's per-unit cap: docs/X402.md).
  if (m.version === 'v1' && m.instructions.some((ix) => ix.program === 'compute-budget')) {
    reasons.push({ code: 'COMPUTE_BUDGET_INSTRUCTION_IN_V1' });
  }
  const limit = m.fees.computeUnitLimit;
  if (m.version === 'v1' && limit === undefined)
    reasons.push({ code: 'COMPUTE_UNIT_LIMIT_MISSING' });
  if (limit !== undefined && limit > config.maxComputeUnitLimit) {
    reasons.push({
      code: 'COMPUTE_UNIT_LIMIT_EXCEEDED',
      detail: `${limit} > ${config.maxComputeUnitLimit}`,
    });
  }
  const totalFee =
    m.fees.source === 'transactionConfig'
      ? m.fees.priorityFeeLamports
      : ((limit === undefined ? ASSUMED_COMPUTE_UNIT_LIMIT : BigInt(limit)) *
          (m.fees.computeUnitPriceMicroLamports ?? 0n) +
          999_999n) /
        1_000_000n;
  if (totalFee > config.maxPriorityFeeLamports) {
    reasons.push({
      code: 'FEE_CAP_EXCEEDED',
      detail: `${totalFee} > ${config.maxPriorityFeeLamports} lamports`,
    });
  }

  // Signers: only the buyer and the fee payer, within the configured count.
  const buyer = shape.transfer?.authority;
  if (m.requiredSigners.length > config.maxRequiredSignatures) {
    reasons.push({
      code: 'UNEXPECTED_SIGNER',
      detail: `${m.requiredSigners.length} required signatures`,
    });
  }
  if (buyer !== undefined) {
    for (const signer of m.requiredSigners) {
      if (signer !== m.feePayer && signer !== buyer)
        reasons.push({ code: 'UNEXPECTED_SIGNER', account: signer });
    }
    const signature = wire.signatures[buyer];
    let valid = false;
    if (signature !== undefined && signature !== null) {
      valid = await verifySignature(
        await getPublicKeyFromAddress(buyer),
        signature,
        messageBytes,
      ).catch(() => false);
    }
    if (!valid) reasons.push({ code: 'X402_PAYER_SIGNATURE_INVALID', account: buyer });
  }

  // Accounts the payment needs must exist.
  const transfer = shape.transfer;
  if (transfer !== undefined) {
    if (asset !== undefined && transfer.decimals !== asset.decimals) {
      reasons.push({ code: 'DECIMALS_MISMATCH', path: transfer.path });
    }
    const source = snapshot.accounts.get(transfer.source);
    if (source === undefined)
      reasons.push({ code: 'ACCOUNT_STATE_MISSING', account: transfer.source });
    else if (source === null)
      reasons.push({ code: 'X402_SOURCE_ACCOUNT_MISSING', account: transfer.source });
    const destination = snapshot.accounts.get(transfer.destination);
    if (destination === undefined)
      reasons.push({ code: 'ACCOUNT_STATE_MISSING', account: transfer.destination });
    else if (destination === null)
      reasons.push({ code: 'DESTINATION_ACCOUNT_MISSING', account: transfer.destination });
  }

  return result({ messageDigest, payer: buyer, amount: transfer?.amount, version: m.version });
}
