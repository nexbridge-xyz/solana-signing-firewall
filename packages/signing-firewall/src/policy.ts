import { type Address, isAddress } from '@solana/kit';

import { canonicalDigest } from './canonical.js';
import type { MessageVersion } from './decode/types.js';

export const POLICY_SCHEMA = 'solana-signing-firewall.policy/v0';
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

export type PolicyNetwork = 'devnet' | 'testnet' | 'mainnet' | 'localnet';

export type MintRule = {
  readonly decimals: number;
  readonly maxPerTransaction: bigint;
  readonly approvalAbove: bigint | undefined;
};

export type X402PolicyBlock = {
  /** CAIP-2 network IDs, for example `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. */
  readonly networks: readonly string[];
  readonly schemes: readonly 'exact'[];
  readonly maxTimeoutSeconds: number;
  readonly maxComputeUnitPriceMicroLamports: bigint;
  readonly createRecipientAccount: 'deny';
  readonly lookupTables: 'deny';
  readonly budgets: ReadonlyMap<Address, { readonly maxPerDay: bigint }>;
  readonly maxPaymentsPerMinute: number;
};

/** A validated policy, with every switch at its strict default when the file leaves it out. */
export type Policy = {
  readonly schema: typeof POLICY_SCHEMA;
  readonly policyId: string;
  readonly network: PolicyNetwork;
  readonly signer: Address;
  readonly feePayers: readonly Address[];
  readonly messageVersions: readonly MessageVersion[];
  readonly durableNonce: 'deny';
  readonly tokenBatch: 'deny' | 'transfers-only';
  readonly mints: ReadonlyMap<Address, MintRule>;
  readonly sources: readonly Address[];
  readonly recipients: {
    readonly owners: readonly Address[];
    readonly requireAssociatedTokenAccount: boolean;
  };
  readonly fees: {
    readonly maxComputeUnitLimit: number;
    readonly maxPriorityFeeLamports: bigint;
    readonly requireExplicitComputeUnitLimit: boolean;
  };
  readonly memo:
    { readonly allowed: false } | { readonly allowed: true; readonly maxBytes: number };
  readonly approval:
    { readonly approvers: readonly Address[]; readonly ttlSeconds: number } | undefined;
  readonly x402: X402PolicyBlock | undefined;
  /** A frozen copy of the policy file's JSON as given. The policy digest is computed over it. */
  readonly json: unknown;
};

export class PolicyError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'PolicyError';
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string, keys: readonly string[]): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyError(path, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new PolicyError(`${path}.${key}`, 'unknown field');
  }
  return value as Json;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PolicyError(path, 'must be a non-empty string');
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PolicyError(path, `must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
  }
  return value as T;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new PolicyError(path, 'must be true or false');
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PolicyError(path, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Amounts are decimal strings in base units, within u64. */
function amount(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PolicyError(path, 'must be a decimal string of base units');
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new PolicyError(path, 'exceeds u64');
  return parsed;
}

function addressOf(value: unknown, path: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new PolicyError(path, 'must be a base58 Solana address');
  }
  return value;
}

function addressList(value: unknown, path: string): Address[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PolicyError(path, 'must be a non-empty array');
  }
  const list = value.map((item, i) => addressOf(item, `${path}[${i}]`));
  if (new Set(list).size !== list.length) throw new PolicyError(path, 'has duplicates');
  return list;
}

function parseX402(value: unknown, path: string): X402PolicyBlock {
  const raw = object(value, path, [
    'networks',
    'schemes',
    'maxTimeoutSeconds',
    'maxComputeUnitPriceMicroLamports',
    'createRecipientAccount',
    'lookupTables',
    'budgets',
    'maxPaymentsPerMinute',
  ]);
  if (!Array.isArray(raw.networks) || raw.networks.length === 0) {
    throw new PolicyError(`${path}.networks`, 'must be a non-empty array');
  }
  const networks = raw.networks.map((n, i) => {
    const network = string(n, `${path}.networks[${i}]`);
    if (!/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(network)) {
      throw new PolicyError(`${path}.networks[${i}]`, 'must be a Solana CAIP-2 network ID');
    }
    return network;
  });
  const schemes =
    raw.schemes === undefined
      ? (['exact'] as const)
      : (() => {
          if (!Array.isArray(raw.schemes) || raw.schemes.length === 0) {
            throw new PolicyError(`${path}.schemes`, 'must be a non-empty array');
          }
          return raw.schemes.map((s, i) => oneOf(s, `${path}.schemes[${i}]`, ['exact'] as const));
        })();
  const budgetsRaw = object(raw.budgets, `${path}.budgets`, Object.keys(raw.budgets ?? {}));
  const budgets = new Map<Address, { maxPerDay: bigint }>();
  for (const [mint, rule] of Object.entries(budgetsRaw)) {
    const rulePath = `${path}.budgets.${mint}`;
    const parsed = object(rule, rulePath, ['maxPerDay']);
    budgets.set(addressOf(mint, rulePath), {
      maxPerDay: amount(parsed.maxPerDay, `${rulePath}.maxPerDay`),
    });
  }
  if (budgets.size === 0) throw new PolicyError(`${path}.budgets`, 'must name at least one mint');
  return {
    networks,
    schemes,
    maxTimeoutSeconds: integer(raw.maxTimeoutSeconds, `${path}.maxTimeoutSeconds`, 1, 3600),
    maxComputeUnitPriceMicroLamports: amount(
      raw.maxComputeUnitPriceMicroLamports,
      `${path}.maxComputeUnitPriceMicroLamports`,
    ),
    createRecipientAccount:
      raw.createRecipientAccount === undefined
        ? 'deny'
        : oneOf(raw.createRecipientAccount, `${path}.createRecipientAccount`, ['deny'] as const),
    lookupTables:
      raw.lookupTables === undefined
        ? 'deny'
        : oneOf(raw.lookupTables, `${path}.lookupTables`, ['deny'] as const),
    budgets,
    maxPaymentsPerMinute: integer(raw.maxPaymentsPerMinute, `${path}.maxPaymentsPerMinute`, 1, 600),
  };
}

/**
 * The path of an object key that is written twice in JSON text, or undefined. JSON.parse()
 * keeps the last of two equal keys and says nothing, so a file can show one value to a reader
 * and give another to the code. The text must already be valid JSON.
 */
function repeatedKey(text: string): string | undefined {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && ' \t\n\r'.includes(text.charAt(i))) i += 1;
  };
  const readString = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
    i += 1;
    // Unescaped, so that "signer" and "sign\u0065r" are the same key.
    return JSON.parse(text.slice(start, i)) as string;
  };
  const readValue = (path: string): string | undefined => {
    skipSpace();
    const first = text.charAt(i);
    if (first === '{') {
      i += 1;
      const seen = new Set<string>();
      skipSpace();
      if (text.charAt(i) === '}') {
        i += 1;
        return undefined;
      }
      for (;;) {
        skipSpace();
        const key = readString();
        if (seen.has(key)) return `${path}.${key}`;
        seen.add(key);
        skipSpace();
        i += 1; // the colon
        const inside = readValue(`${path}.${key}`);
        if (inside !== undefined) return inside;
        skipSpace();
        const next = text.charAt(i);
        i += 1; // a comma or the closing brace
        if (next !== ',') return undefined;
      }
    }
    if (first === '[') {
      i += 1;
      skipSpace();
      if (text.charAt(i) === ']') {
        i += 1;
        return undefined;
      }
      for (let index = 0; ; index += 1) {
        const inside = readValue(`${path}[${index}]`);
        if (inside !== undefined) return inside;
        skipSpace();
        const next = text.charAt(i);
        i += 1; // a comma or the closing bracket
        if (next !== ',') return undefined;
      }
    }
    if (first === '"') {
      readString();
      return undefined;
    }
    // A number, true, false or null.
    while (i < text.length && !',]} \t\n\r'.includes(text.charAt(i))) i += 1;
    return undefined;
  };
  return readValue('policy');
}

/**
 * Reads a policy from the text of its file. Like `parsePolicy(JSON.parse(text))`, and it also
 * refuses a file in which a key is written twice, so that what a person reads in the file is
 * what is enforced. Throws PolicyError.
 */
export function parsePolicyText(text: string): Policy {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PolicyError('policy', 'is not valid JSON');
  }
  const repeated = repeatedKey(text);
  if (repeated !== undefined) throw new PolicyError(repeated, 'is written twice in the file');
  return parsePolicy(json);
}

/** A frozen copy of a JSON value, sharing nothing with the original. */
function frozenCopy(json: unknown): unknown {
  const freeze = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(JSON.parse(JSON.stringify(json)) as unknown);
}

/**
 * Validates a policy file's JSON. Unknown fields are rejected; switches left
 * out take their strict default. Throws PolicyError with the failing path.
 * To load a file, prefer `parsePolicyText()`: it also refuses repeated keys.
 */
export function parsePolicy(given: unknown): Policy {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new PolicyError('policy', 'must be an object');
  }
  // Our own copy: the rules below and the digest are taken from the same, unchangeable value,
  // whatever the caller does with its object afterwards.
  let json: unknown;
  try {
    json = frozenCopy(given);
  } catch {
    // A bigint, or an object that refers to itself: not something a JSON file can hold.
    throw new PolicyError('policy', 'must be plain JSON');
  }
  const raw = object(json, 'policy', [
    'schema',
    'policyId',
    'network',
    'signer',
    'feePayers',
    'messageVersions',
    'durableNonce',
    'tokenBatch',
    'mints',
    'sources',
    'recipients',
    'fees',
    'memo',
    'approval',
    'x402',
  ]);
  if (raw.schema !== POLICY_SCHEMA)
    throw new PolicyError('policy.schema', `must be "${POLICY_SCHEMA}"`);

  if (!Array.isArray(raw.messageVersions) || raw.messageVersions.length === 0) {
    throw new PolicyError('policy.messageVersions', 'must be a non-empty array');
  }
  const messageVersions = raw.messageVersions.map((v, i) =>
    oneOf(v, `policy.messageVersions[${i}]`, ['legacy', 'v0', 'v1'] as const),
  );
  if (new Set(messageVersions).size !== messageVersions.length) {
    throw new PolicyError('policy.messageVersions', 'has duplicates');
  }

  const mintsRaw = object(raw.mints, 'policy.mints', Object.keys(raw.mints ?? {}));
  const mints = new Map<Address, MintRule>();
  for (const [mint, rule] of Object.entries(mintsRaw)) {
    const path = `policy.mints.${mint}`;
    const parsed = object(rule, path, ['decimals', 'maxPerTransaction', 'approvalAbove']);
    mints.set(addressOf(mint, path), {
      decimals: integer(parsed.decimals, `${path}.decimals`, 0, 255),
      maxPerTransaction: amount(parsed.maxPerTransaction, `${path}.maxPerTransaction`),
      approvalAbove:
        parsed.approvalAbove === undefined
          ? undefined
          : amount(parsed.approvalAbove, `${path}.approvalAbove`),
    });
  }
  if (mints.size === 0) throw new PolicyError('policy.mints', 'must name at least one mint');

  const recipientsRaw = object(raw.recipients, 'policy.recipients', [
    'owners',
    'requireAssociatedTokenAccount',
  ]);
  const feesRaw = object(raw.fees, 'policy.fees', [
    'maxComputeUnitLimit',
    'maxPriorityFeeLamports',
    'requireExplicitComputeUnitLimit',
  ]);

  let memo: Policy['memo'] = { allowed: false };
  if (raw.memo !== undefined) {
    const memoRaw = object(raw.memo, 'policy.memo', ['allowed', 'maxBytes']);
    if (boolean(memoRaw.allowed, 'policy.memo.allowed')) {
      memo = {
        allowed: true,
        maxBytes: integer(memoRaw.maxBytes, 'policy.memo.maxBytes', 1, 1024),
      };
    } else if (memoRaw.maxBytes !== undefined) {
      integer(memoRaw.maxBytes, 'policy.memo.maxBytes', 1, 1024);
    }
  }

  let approval: Policy['approval'];
  if (raw.approval !== undefined) {
    const approvalRaw = object(raw.approval, 'policy.approval', ['approvers', 'ttlSeconds']);
    approval = {
      approvers: addressList(approvalRaw.approvers, 'policy.approval.approvers'),
      ttlSeconds: integer(approvalRaw.ttlSeconds, 'policy.approval.ttlSeconds', 1, 86_400),
    };
  }
  for (const [mint, rule] of mints) {
    if (rule.approvalAbove !== undefined && approval === undefined) {
      throw new PolicyError(`policy.mints.${mint}.approvalAbove`, 'needs an "approval" section');
    }
  }

  return {
    schema: POLICY_SCHEMA,
    policyId: string(raw.policyId, 'policy.policyId'),
    network: oneOf(raw.network, 'policy.network', [
      'devnet',
      'testnet',
      'mainnet',
      'localnet',
    ] as const),
    signer: addressOf(raw.signer, 'policy.signer'),
    feePayers: addressList(raw.feePayers, 'policy.feePayers'),
    messageVersions,
    durableNonce:
      raw.durableNonce === undefined
        ? 'deny'
        : oneOf(raw.durableNonce, 'policy.durableNonce', ['deny'] as const),
    tokenBatch:
      raw.tokenBatch === undefined
        ? 'deny'
        : oneOf(raw.tokenBatch, 'policy.tokenBatch', ['deny', 'transfers-only'] as const),
    mints,
    sources: addressList(raw.sources, 'policy.sources'),
    recipients: {
      owners: addressList(recipientsRaw.owners, 'policy.recipients.owners'),
      requireAssociatedTokenAccount:
        recipientsRaw.requireAssociatedTokenAccount === undefined
          ? true
          : boolean(
              recipientsRaw.requireAssociatedTokenAccount,
              'policy.recipients.requireAssociatedTokenAccount',
            ),
    },
    fees: {
      maxComputeUnitLimit: integer(
        feesRaw.maxComputeUnitLimit,
        'policy.fees.maxComputeUnitLimit',
        1,
        MAX_COMPUTE_UNIT_LIMIT,
      ),
      maxPriorityFeeLamports: amount(
        feesRaw.maxPriorityFeeLamports,
        'policy.fees.maxPriorityFeeLamports',
      ),
      requireExplicitComputeUnitLimit:
        feesRaw.requireExplicitComputeUnitLimit === undefined
          ? true
          : boolean(
              feesRaw.requireExplicitComputeUnitLimit,
              'policy.fees.requireExplicitComputeUnitLimit',
            ),
    },
    memo,
    approval,
    x402: raw.x402 === undefined ? undefined : parseX402(raw.x402, 'policy.x402'),
    json,
  };
}

/** SHA-256 (hex) of the RFC 8785 canonical JSON of the policy file as given. */
export function policyDigest(policy: Policy): string {
  return canonicalDigest(policy.json);
}
