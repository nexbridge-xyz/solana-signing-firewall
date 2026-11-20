import type { ReasonCode, SnapshotJson } from '@nexbridge/solana-signing-firewall';

/** Decoder facts a vector pins down, independent of any policy. */
export type DecodedExpectation = {
  version: 'legacy' | 'v0' | 'v1';
  feePayer: string;
  requiredSigners: string[];
  lifetime: 'blockhash' | 'nonce';
  instructions: { path: string; program: string; type: string | null }[];
  transfers: {
    path: string;
    source: string;
    mint: string;
    destination: string;
    authority: string;
    amount: string;
    decimals: number;
  }[];
  fees:
    | {
        source: 'instructions';
        computeUnitLimit: number | null;
        computeUnitPriceMicroLamports: string | null;
      }
    | {
        source: 'transactionConfig';
        computeUnitLimit: number | null;
        loadedAccountsDataSizeLimit: number | null;
        heapSize: number | null;
        priorityFeeLamports: string;
      };
  lookupTableEntries: { table: string; index: number; address: string; writable: boolean }[];
};

export type Outcome = 'allow' | 'needs_approval' | 'deny';

/** One file in vectors/core/. docs/FIXTURES.md documents the format. */
export type CoreVector = {
  id: string;
  title: string;
  category: string;
  /** From the first message byte: `unsupported` when it is 0x82 or above. */
  messageVersion: 'legacy' | 'v0' | 'v1' | 'unsupported';
  notes?: string;
  /** Message bytes (what the signer signs), base64. */
  message: string;
  /** Path of the policy file, relative to vectors/core/. */
  policy: string;
  snapshot: SnapshotJson;
  now: string;
  expect: {
    outcome: Outcome;
    /** The set of reason codes. Order is not significant. */
    reasons: ReasonCode[];
    decoded?: DecodedExpectation;
  };
};

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
