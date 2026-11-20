// The policies of the devnet demo. They mirror the fixture policies, with the
// demo's own addresses.
import { POLICY_SCHEMA, X402_VERIFIER_SCHEMA } from '@nexbridge/solana-signing-firewall';

import type { Cast } from './cast.js';

/** CAIP-2 identifier of devnet, as x402 names it. */
export const DEVNET_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/** `devnet` for the recorded run; `localnet` for rehearsals against LiteSVM. */
export type DemoNetwork = 'devnet' | 'localnet';

/** Scenes 1 to 11: the treasury pays two vendors. */
export function payoutsPolicyJson(cast: Cast, network: DemoNetwork) {
  return {
    schema: POLICY_SCHEMA,
    policyId: 'demo-payouts',
    network,
    signer: cast.treasury,
    feePayers: [cast.treasury],
    messageVersions: ['legacy', 'v0', 'v1'],
    durableNonce: 'deny',
    tokenBatch: 'transfers-only',
    mints: {
      [cast.mint]: { decimals: 6, maxPerTransaction: '5000000', approvalAbove: '2000000' },
    },
    sources: [cast.treasuryAta],
    recipients: { owners: [cast.vendorA, cast.vendorB], requireAssociatedTokenAccount: true },
    fees: {
      maxComputeUnitLimit: 200000,
      maxPriorityFeeLamports: '50000',
      requireExplicitComputeUnitLimit: true,
    },
    approval: { approvers: [cast.approver], ttlSeconds: 90 },
  };
}

/** Scenes 12 to 14: the agent's own policy, with its x402 block. */
export function agentPolicyJson(cast: Cast, network: DemoNetwork) {
  return {
    schema: POLICY_SCHEMA,
    policyId: 'demo-agent',
    network,
    signer: cast.agent,
    feePayers: [cast.facilitatorFeePayer],
    messageVersions: ['v0', 'v1'],
    durableNonce: 'deny',
    tokenBatch: 'deny',
    mints: { [cast.mint]: { decimals: 6, maxPerTransaction: '20000' } },
    sources: [cast.agentAta],
    recipients: { owners: [cast.shop], requireAssociatedTokenAccount: true },
    fees: {
      maxComputeUnitLimit: 200000,
      maxPriorityFeeLamports: '50000',
      requireExplicitComputeUnitLimit: true,
    },
    memo: { allowed: true, maxBytes: 256 },
    x402: {
      networks: [DEVNET_CAIP2],
      schemes: ['exact'],
      maxTimeoutSeconds: 120,
      maxComputeUnitPriceMicroLamports: '5000000',
      createRecipientAccount: 'deny',
      lookupTables: 'deny',
      budgets: { [cast.mint]: { maxPerDay: '50000' } },
      maxPaymentsPerMinute: 10,
    },
  };
}

/** Scene 15: the local facilitator's verifier configuration. */
export function verifierConfigJson(cast: Cast) {
  return {
    schema: X402_VERIFIER_SCHEMA,
    networks: [DEVNET_CAIP2],
    feePayers: [cast.facilitatorFeePayer],
    messageVersions: ['v0', 'v1'],
    assets: { [cast.mint]: { decimals: 6 } },
    maxComputeUnitLimit: 200000,
    maxComputeUnitPriceMicroLamports: '5000000',
    maxPriorityFeeLamports: '100000',
    maxRequiredSignatures: 2,
    durableNonce: 'deny',
    createRecipientAccount: 'deny',
    lookupTables: 'deny',
  };
}
