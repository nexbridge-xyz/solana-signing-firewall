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
  /** From the first message byte: `unsupported` when it is 0x82 or above, `none` when empty. */
  messageVersion: 'legacy' | 'v0' | 'v1' | 'unsupported' | 'none';
  /**
   * What the Solana runtime itself does with this message, signed by its required
   * signers and run against the snapshot: `runtime_accepts` (it executes) or
   * `runtime_rejects` (sanitization or execution fails). A deny vector marked
   * `runtime_accepts` shows a check that is stricter than the runtime.
   */
  runtimeVerdict: 'runtime_accepts' | 'runtime_rejects';
  /** `litesvm` when a test confirms the verdict in LiteSVM; otherwise `not_checked`, with a note. */
  runtimeCheckedBy: 'litesvm' | 'not_checked';
  notes?: string;
  /** Message bytes (what the signer signs), base64. */
  message: string;
  /** Path of the policy file, relative to vectors/core/. */
  policy: string;
  snapshot: SnapshotJson;
  now: string;
  /** An approval record presented for this message, if any. */
  approval?: unknown;
  expect: {
    outcome: Outcome;
    /** The set of reason codes. Order is not significant. */
    reasons: ReasonCode[];
    /**
     * For `needs_approval` vectors: the approval check. No approval presented gives
     * `APPROVAL_REQUIRED`; an empty set means the approval is valid and signing proceeds.
     */
    approval?: { reasons: ReasonCode[] };
    decoded?: DecodedExpectation;
  };
};

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
