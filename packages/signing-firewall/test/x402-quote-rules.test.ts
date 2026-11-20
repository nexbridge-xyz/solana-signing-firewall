// Three quote rules that no vector exercises: a quote above `approvalAbove`, a quote whose
// advertised versions the policy does not accept, and an asset without a daily budget. Each test
// changes one thing in an otherwise acceptable quote.
import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner } from '@solana/kit';

import {
  type Policy,
  type X402PolicyBlock,
  checkQuote,
  createMemoryLedger,
  parsePolicy,
} from '../src/index.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const now = new Date('2026-11-20T00:00:00.000Z');

const agent = (await generateKeyPairSigner()).address;
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const mint = (await generateKeyPairSigner()).address;
const otherMint = (await generateKeyPairSigner()).address;
const source = (await generateKeyPairSigner()).address;

function policyWith(changes: {
  readonly approvalAbove?: string;
  readonly messageVersions?: readonly string[];
  readonly withoutBudget?: Address;
}): Policy & { readonly x402: X402PolicyBlock } {
  const budgets = Object.fromEntries(
    [mint, otherMint]
      .filter((asset) => asset !== changes.withoutBudget)
      .map((asset) => [asset, { maxPerDay: '50000' }]),
  );
  const policy = parsePolicy({
    schema: 'solana-signing-firewall.policy/v0',
    policyId: 'agent',
    network: 'localnet',
    signer: agent,
    feePayers: [feePayer],
    messageVersions: changes.messageVersions ?? ['v0', 'v1'],
    mints: {
      [mint]: {
        decimals: 6,
        maxPerTransaction: '20000',
        ...(changes.approvalAbove === undefined ? {} : { approvalAbove: changes.approvalAbove }),
      },
      [otherMint]: { decimals: 6, maxPerTransaction: '20000' },
    },
    sources: [source],
    recipients: { owners: [shop] },
    fees: { maxComputeUnitLimit: 200000, maxPriorityFeeLamports: '50000' },
    x402: {
      networks: [DEVNET],
      maxTimeoutSeconds: 120,
      maxComputeUnitPriceMicroLamports: '5000000',
      budgets,
      maxPaymentsPerMinute: 10,
    },
    ...(changes.approvalAbove === undefined
      ? {}
      : { approval: { approvers: [feePayer], ttlSeconds: 60 } }),
  });
  if (policy.x402 === undefined) throw new Error('the test policy has an x402 block');
  return { ...policy, x402: policy.x402 };
}

const quote = (asset: Address = mint, versions: number[] = [0, 1]) => ({
  scheme: 'exact',
  network: DEVNET,
  amount: '20000',
  asset,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra: { feePayer, transactionVersions: versions },
});

const codes = (json: unknown, policy: Policy & { readonly x402: X402PolicyBlock }) =>
  checkQuote(json, 0, { policy, ledger: createMemoryLedger(), now }).reasons.map((r) => r.code);

describe('quote rules without a vector', () => {
  it('accepts the quote these tests start from (control)', () => {
    expect(codes(quote(), policyWith({}))).toEqual([]);
  });

  it('refuses a quote above approvalAbove: an x402 payment never waits for a person', () => {
    expect(codes(quote(), policyWith({ approvalAbove: '10000' }))).toEqual(['APPROVAL_REQUIRED']);
    expect(codes(quote(), policyWith({ approvalAbove: '20000' }))).toEqual([]);
  });

  it('refuses a quote whose advertised versions the policy accepts none of', () => {
    expect(codes(quote(mint, [1]), policyWith({ messageVersions: ['v0'] }))).toEqual([
      'VERSION_NOT_ALLOWED',
    ]);
    expect(codes(quote(mint, [0, 1]), policyWith({ messageVersions: ['v0'] }))).toEqual([]);
  });

  it('refuses an allowed asset for which the policy sets no daily budget', () => {
    expect(codes(quote(otherMint), policyWith({ withoutBudget: otherMint }))).toEqual([
      'X402_BUDGET_EXCEEDED',
    ]);
    expect(codes(quote(otherMint), policyWith({}))).toEqual([]);
  });
});
