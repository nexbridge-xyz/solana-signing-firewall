// What the pinned spec says about each x402 vector: the sections it exercises, the verdict and
// a note. The spec is scheme_exact_svm.md of x402-foundation/x402 at 4f64aba41; docs/FIXTURES.md
// defines the verdicts.

export type SpecVerdict = 'must_accept' | 'must_reject' | 'stricter_than_spec';

export type SpecLabel = {
  readonly specRules: readonly string[];
  readonly specVerdict: SpecVerdict;
  readonly notes?: string;
};

export const X402_SPEC_LABELS: Readonly<Record<string, SpecLabel>> = {
  'x402-001': {
    specRules: ['§1.1', '§1.4', '§3.1'],
    specVerdict: 'must_accept',
  },
  'x402-002': {
    specRules: ['§1.5', '§3.1'],
    specVerdict: 'must_accept',
  },
  'x402-003': {
    specRules: ['PaymentRequirements for exact', '§3.1'],
    specVerdict: 'must_accept',
  },
  'x402-004': {
    specRules: ['§1.1', '§1.4'],
    specVerdict: 'must_reject',
    notes:
      '§1.4: "MUST reject if zero matching transfers are found." An `ApproveChecked` moves no tokens.',
  },
  'x402-005': {
    specRules: ['§1.1', '§1.4'],
    specVerdict: 'must_reject',
    notes: '§1.4: "MUST reject if zero matching transfers are found."',
  },
  'x402-006': {
    specRules: ['§1.1', '§1.2', '§1.4'],
    specVerdict: 'must_reject',
    notes:
      '§1.4: "MUST reject if zero matching transfers are found." A matching transfer goes to "the Associated Token Account derived from `payTo` and `asset`" (§1.1).',
  },
  'x402-007': {
    specRules: ['§1.4'],
    specVerdict: 'must_reject',
    notes:
      '§1.4: "A matching transfer MAY exceed `PaymentRequirements.amount` (overpayment is tolerated to accommodate smart wallets with internal fee rounding); it MUST NOT be less."',
  },
  'x402-008': {
    specRules: ['§1.4'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec tolerates overpayment: "A matching transfer MAY exceed `PaymentRequirements.amount`" (§1.4). The guard and the verifier require the quoted amount exactly (docs/DECISIONS.md D8).',
  },
  'x402-009': {
    specRules: ['§1.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec accepts a `token-2022` `TransferChecked` (§1.1); v0.1.0 refuses Token-2022 payments (docs/DECISIONS.md D26). The Token-2022 mint is also missing from the agent policy and the verifier config, so this vector does not isolate that rule.',
  },
  'x402-010': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence of the spec is about another SPL Token instruction beside the transfer. The catch-all of the reference implementation\'s static path is about other programs: "**Any other program**, anywhere in the sequence, MUST be rejected (`invalid_exact_svm_payload_unknown_instruction`)." (§3.1). The guard and the verifier accept only the layout of docs/DECISIONS.md D8.',
  },
  'x402-011': {
    specRules: ['§1.1', '§1.4'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec does not mention P-Token `batch`. §1.4: "Across all top-level instructions and the full CPI trace, **exactly one** transfer MUST match the requirements (correct mint, correct destination ATA, amount `>=` required)." Whether a `TransferChecked` inside a batch counts is not stated. The guard and the verifier accept only a top-level `TransferChecked` (docs/DECISIONS.md D8).',
  },
  'x402-012': {
    specRules: ['§2.1.1', '§2.1.3'],
    specVerdict: 'must_reject',
    notes:
      '§2.1.1: "The `feePayer` MUST NOT be used as an authority, source, or delegate for any transfer."',
  },
  'x402-013': {
    specRules: ['PaymentRequirements for exact'],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence requires the transaction\'s fee payer to be the one the quote names ("`extra.feePayer`: The sponsor\'s public key."). The guard and the verifier require it (docs/DECISIONS.md D53).',
  },
  'x402-014': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The words "durable" and "AdvanceNonce" do not occur in the spec. On the reference implementation\'s static path the System Program instruction falls under "**Any other program**, anywhere in the sequence, MUST be rejected" (§3.1). The guard and the verifier refuse a durable nonce (docs/DECISIONS.md D53).',
  },
  'x402-015': {
    specRules: ['§2.2.1', '§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The cap is a setting of the reference implementation\'s static path: "The legacy/version-0 Compute Budget price and the version-1 total priority fee MUST each be no greater than `maxPriorityFeeMicroLamports` (default 5 lamports/CU) on this path, using the normalization in §1.5 for version 1." (§3.1), listed under "Reference defaults (operator-configurable):" (§2.2.1). The vector breaks that default, 5,000,000 micro-lamports per unit, which the agent policy (`x402.maxComputeUnitPriceMicroLamports`) and the verifier config (`maxComputeUnitPriceMicroLamports`) both use. `FEE_CAP_EXCEEDED` is a cap of our own (docs/DECISIONS.md D53).',
  },
  'x402-016': {
    specRules: ['§1.5', '§2.2.1'],
    specVerdict: 'must_reject',
    notes:
      '§1.5: "As an x402 sponsor rule, a client-built version-1 transaction MUST NOT contain them, and the sponsor MUST reject one that does." ("them": Compute Budget program instructions.) The other codes come from caps that are settings or our own (docs/DECISIONS.md D53).',
  },
  'x402-017': {
    specRules: ['§2.1.1', '§5.4'],
    specVerdict: 'must_reject',
    notes:
      '§5.4: "A Sponsor MUST reject any transaction in which the fee payer funds ATA creation for an unmarked recipient, for an owner outside the declared recipient set (`payTo` and every `splits[].payTo`), or when it has not advertised ATA sponsorship (`split_ata_creation_not_authorized`)."',
  },
  'x402-018': {
    specRules: ['§2.1.2'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec lets a sponsor accept lookup tables it can resolve: "If the transaction uses Address Lookup Tables (ALTs), the sponsor MUST resolve them so that every account the transaction can touch is visible before the isolation check in §2.1.1 runs." (§2.1.2). v0.1.0 refuses them (`lookupTables: "deny"`; docs/DECISIONS.md D53).',
  },
  'x402-019': {
    specRules: ['§2.1.4'],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence asks a sponsor to verify the client\'s signature ("sigVerify" does not occur); §2.1.4 is about which signatures are required. The verifier checks it (docs/DECISIONS.md D53).',
  },
  'x402-020': {
    specRules: ['§1.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      "No sentence requires the buyer's token account to exist; such a transfer fails on chain. The guard and the verifier require it (docs/DECISIONS.md D53).",
  },
  'x402-021': {
    specRules: ['§2.1.4'],
    specVerdict: 'must_reject',
    notes:
      '§2.1.4: "The transaction MUST NOT require any signatures beyond the client and the sponsor (`feePayer`)."',
  },
  'x402-022': {
    specRules: ['§5.2'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec says "All amounts are integers in base units." (§5.2), with no MUST about a quote whose amount is not one. The guard and the verifier refuse it as malformed (docs/DECISIONS.md D53).',
  },
  'x402-023': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'For the client: "Clients MUST include a Memo instruction containing either the value of `extra.memo` (when present) or a random nonce (at least 16 bytes, hex-encoded for UTF-8 compliance)." (§3.1) For a facilitator: "Memo instructions after the transfer MAY repeat; their count is constrained only when `extra.memo` is present." (§3.1) The verifier requires a nonce Memo (docs/DECISIONS.md D7, D53).',
  },
  'x402-024': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      '"Memo instructions after the transfer MAY repeat; their count is constrained only when `extra.memo` is present." (§3.1) The verifier accepts it; the guard accepts only one Memo (docs/DECISIONS.md D7).',
  },
  'x402-025': {
    specRules: ['PaymentRequirements for exact', '§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'For the client: "When present, the client MUST use this value as the Memo instruction data instead of a random nonce." (`extra.memo`, section "`PaymentRequirements` for `exact`"). For a facilitator the rule is on the reference implementation\'s static path: "If `extra.memo` is present, the facilitator MUST verify that exactly one Memo instruction exists (`invalid_exact_svm_payload_memo_count` otherwise) and that its data matches `extra.memo` encoded as UTF-8." (§3.1). The guard and the verifier apply it (docs/DECISIONS.md D7).',
  },
  'x402-026': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'For the client: "Clients MUST include a Memo instruction containing either the value of `extra.memo` (when present) or a random nonce (at least 16 bytes, hex-encoded for UTF-8 compliance)." (§3.1) No sentence tells a facilitator to refuse a payment whose Memo is not one. The verifier requires a hex nonce of at least 32 characters (docs/DECISIONS.md D7, D53).',
  },
  'x402-027': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The client rule asks for a nonce of "at least 16 bytes" (§3.1), so the verifier accepts it; the guard accepts only the 32 lower-case hex characters of a 16-byte nonce (docs/DECISIONS.md D7).',
  },
  'x402-028': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec does not state the letter case of the hex nonce (docs/FIXTURES.md, open questions). The verifier accepts it; the guard accepts lower case only (docs/DECISIONS.md D7).',
  },
  'x402-029': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'A rule of the reference implementation\'s static path: "A `Memo` before the first `TransferChecked` MUST be rejected (`invalid_exact_svm_payload_transaction_instructions_order`)." (§3.1). The guard and the verifier apply it (docs/DECISIONS.md D8).',
  },
  'x402-030': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence of the spec is about accounts on a Memo instruction. The verifier accepts it; the guard accepts only a Memo without accounts (docs/DECISIONS.md D7).',
  },
  'x402-031': {
    specRules: ['§5.6'],
    specVerdict: 'must_reject',
    notes:
      '§5.6: "Before signing, the client MUST verify that `extra.splits` — when present — contains only the recipients and amounts it expects." The agent policy expects no split; the guard refuses every split (docs/DECISIONS.md D9).',
  },
  'x402-032': {
    specRules: ['§5.4', '§5.6'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The client chooses: among the steps the client MUST take, §5.6 lists "Reject requirements whose split recipients or amounts it did not agree to, and reject any `ataCreationRequired: true` it is unwilling to fund." The guard refuses every such quote (docs/DECISIONS.md D9).',
  },
  'x402-033': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'This spec covers the `exact` scheme only, so it says nothing about an `upto` quote. The agent policy accepts the schemes in `x402.schemes` (docs/DECISIONS.md D52).',
  },
  'x402-034': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the networks it pays on, `x402.networks` (docs/DECISIONS.md D52).',
  },
  'x402-035': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the assets it pays with, `mints` (docs/DECISIONS.md D52).',
  },
  'x402-036': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the payees, `recipients` (docs/DECISIONS.md D52).',
  },
  'x402-037': {
    specRules: ['PaymentRequirements for exact', '§2.1.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence binds a client here. A payment under this quote would make the fee payer the transfer authority, which a sponsor must refuse: §2.1.1: "The `feePayer` MUST NOT be used as an authority, source, or delegate for any transfer." The agent policy lists the fee payers it accepts, `feePayers` (docs/DECISIONS.md D52).',
  },
  'x402-038': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the cap per payment, `mints.<mint>.maxPerTransaction` (docs/DECISIONS.md D52).',
  },
  'x402-039': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'No sentence of the spec forbids a zero amount. The guard and the verifier refuse it (docs/DECISIONS.md D52, D53).',
  },
  'x402-040': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the longest timeout it accepts, `x402.maxTimeoutSeconds` (docs/DECISIONS.md D52).',
  },
  'x402-041': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the daily budget, `x402.budgets` (docs/DECISIONS.md D52).',
  },
  'x402-042': {
    specRules: [],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec leaves this to the client; the agent policy sets it: the rate limit, `x402.maxPaymentsPerMinute` (docs/DECISIONS.md D52).',
  },
  'x402-043': {
    specRules: ['PaymentRequirements for exact'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec lists `extra.feePayer` after "In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Solana requires the following inside the `extra` field:", with no MUST for a client given a quote without it. The guard refuses it (docs/DECISIONS.md D52).',
  },
  'x402-044': {
    specRules: ['§1.5', '§2.2.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'For the client: "A transaction that leaves bit 2 or bit 3 unset therefore cannot execute its instructions, so a client-built version-1 transaction MUST set both." (§1.5). For a sponsor, "`loadedAccountsDataSizeLimit` (bit 3) MUST be set" is part of §2.2.1, "Compute Budget Controls (SHOULD)". The guard and the verifier require it (docs/DECISIONS.md D26).',
  },
  'x402-045': {
    specRules: ['§1.2', '§1.4'],
    specVerdict: 'must_reject',
    notes:
      '§1.4: "MUST reject if zero matching transfers are found." A matching transfer has the "correct mint" (§1.4).',
  },
};
