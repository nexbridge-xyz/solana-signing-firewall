import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';

import { type ReviewDecision, decisionToJson } from '../src/index.js';

const A = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const B = address('11111111111111111111111111111111');

describe('decisionToJson', () => {
  it('turns every bigint into a decimal string and copies every list', () => {
    const decision: ReviewDecision = {
      outcome: 'deny',
      reasons: [{ code: 'FEE_CAP_EXCEEDED', path: 'ix[1]' }],
      messageDigest: 'aa',
      policyDigest: 'bb',
      policyId: 'p',
      version: 'v0',
      feePayer: A,
      requiredSigners: [A],
      lifetime: { type: 'blockhash', token: 'h' },
      transfers: [
        {
          path: 'ix[0]',
          source: A,
          mint: B,
          destination: A,
          authority: A,
          multisigSigners: [],
          amount: 18_446_744_073_709_551_615n,
          decimals: 6,
          destinationOwner: B,
        },
      ],
      totals: [{ mint: B, amount: 2n }],
      fees: {
        source: 'instructions',
        computeUnitLimit: 30_000,
        computeUnitPriceMicroLamports: 1_000n,
        priorityFeeLamports: 30n,
        loadedAccountsDataSizeLimit: undefined,
        heapSize: undefined,
      },
      lookupTableEntries: [{ table: A, index: 3, address: B, writable: true }],
      snapshotSlot: 7n,
    };
    const json = decisionToJson(decision);
    expect(json).toEqual({
      outcome: 'deny',
      reasons: [{ code: 'FEE_CAP_EXCEEDED', path: 'ix[1]' }],
      messageDigest: 'aa',
      policyDigest: 'bb',
      policyId: 'p',
      version: 'v0',
      feePayer: A,
      requiredSigners: [A],
      lifetime: { type: 'blockhash', token: 'h' },
      transfers: [
        {
          path: 'ix[0]',
          mint: B,
          amount: '18446744073709551615',
          decimals: 6,
          source: A,
          destination: A,
          destinationOwner: B,
          authority: A,
        },
      ],
      totals: [{ mint: B, amount: '2' }],
      fees: {
        source: 'instructions',
        computeUnitLimit: 30_000,
        computeUnitPriceMicroLamports: '1000',
        priorityFeeLamports: '30',
        loadedAccountsDataSizeLimit: null,
        heapSize: null,
      },
      lookupTableEntries: [{ table: A, index: 3, address: B, writable: true }],
      snapshotSlot: '7',
    });
    expect(json.reasons[0]).not.toBe(decision.reasons[0]);
    expect(json.lookupTableEntries[0]).not.toBe(decision.lookupTableEntries[0]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('writes null for what an undecodable message lacks', () => {
    const json = decisionToJson({
      outcome: 'deny',
      reasons: [{ code: 'MALFORMED_MESSAGE' }],
      messageDigest: 'aa',
      policyDigest: 'bb',
      policyId: 'p',
      version: undefined,
      feePayer: undefined,
      requiredSigners: [],
      lifetime: undefined,
      transfers: [],
      totals: [],
      fees: undefined,
      lookupTableEntries: [],
      snapshotSlot: 0n,
    });
    expect(json).toMatchObject({
      version: null,
      feePayer: null,
      lifetime: null,
      fees: null,
      transfers: [],
      totals: [],
      requiredSigners: [],
    });
  });

  it('keeps the version-1 fee fields', () => {
    const json = decisionToJson({
      outcome: 'allow',
      reasons: [],
      messageDigest: 'aa',
      policyDigest: 'bb',
      policyId: 'p',
      version: 'v1',
      feePayer: A,
      requiredSigners: [A],
      lifetime: { type: 'blockhash', token: 'h' },
      transfers: [],
      totals: [],
      fees: {
        source: 'transactionConfig',
        computeUnitLimit: undefined,
        computeUnitPriceMicroLamports: undefined,
        priorityFeeLamports: 10_000n,
        loadedAccountsDataSizeLimit: 1_048_576,
        heapSize: 65_536,
      },
      lookupTableEntries: [],
      snapshotSlot: 1n,
    });
    expect(json.fees).toEqual({
      source: 'transactionConfig',
      computeUnitLimit: null,
      computeUnitPriceMicroLamports: null,
      priorityFeeLamports: '10000',
      loadedAccountsDataSizeLimit: 1_048_576,
      heapSize: 65_536,
    });
  });
});
