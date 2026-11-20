import type { ReasonCode, SnapshotJson } from '@nexbridge/solana-signing-firewall';

import type { SpecVerdict } from './labels.js';

/** One file in vectors/x402/. docs/FIXTURES.md documents the format. */
export type X402Vector = {
  id: string;
  title: string;
  /** Sections of the official scheme_exact_svm.md this vector exercises. */
  specRules: string[];
  /**
   * What the pinned spec says of the vector, independent of our reason codes: `must_accept`
   * (meets every MUST), `must_reject` (breaks a MUST that binds every facilitator, or for a
   * client-only vector every client), or `stricter_than_spec` (breaks none of those, and our
   * guard or verifier refuses it). docs/FIXTURES.md and labels.ts.
   */
  specVerdict: SpecVerdict;
  notes?: string;
  /** One payment option, as a server would send it. */
  requirements: unknown;
  /** The partially signed wire transaction, base64. Absent for quote-level vectors. */
  transaction?: string;
  /** Path of the agent policy, relative to vectors/x402/. Present when `expect.client` is. */
  policy?: string;
  /** Path of the verifier config, relative to vectors/x402/. Present when `expect.facilitator` is. */
  verifierConfig?: string;
  snapshot: SnapshotJson;
  /** Reservations already in the budget ledger. Amounts are decimal strings. */
  ledger?: {
    time: string;
    mint: string;
    amount: string;
    payee: string;
    requirementsDigest: string;
    messageDigest: string;
  }[];
  now: string;
  expect: {
    /** The agent-side guard: the quote checks, or the full review of the transaction. */
    client?: { outcome: 'allow' | 'deny'; reasons: ReasonCode[] };
    /** The facilitator-side verifier. */
    facilitator?: { outcome: 'valid' | 'invalid'; reasons: ReasonCode[] };
  };
};
