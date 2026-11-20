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
    specRules: ['§3.1'],
    specVerdict: 'must_accept',
  },
  'x402-004': {
    specRules: ['§1.1', '§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-005': {
    specRules: ['§1.1', '§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-006': {
    specRules: ['§1.2', '§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-007': {
    specRules: ['§1.4'],
    specVerdict: 'must_reject',
  },
  'x402-008': {
    specRules: ['§1.4'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec tolerates overpayment; we require the quoted amount exactly (docs/DECISIONS.md D8).',
  },
  'x402-009': {
    specRules: ['§1.1'],
    specVerdict: 'stricter_than_spec',
    notes: 'The spec allows Token-2022 assets; v0.1.0 does not.',
  },
  'x402-010': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-011': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-012': {
    specRules: ['§2.1.1', '§2.1.3'],
    specVerdict: 'must_reject',
  },
  'x402-013': {
    specRules: ['§2.1.1'],
    specVerdict: 'must_reject',
  },
  'x402-014': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-015': {
    specRules: ['§2.2.1', '§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-016': {
    specRules: ['§1.5', '§2.2.1'],
    specVerdict: 'must_reject',
  },
  'x402-017': {
    specRules: ['§5.4'],
    specVerdict: 'must_reject',
  },
  'x402-018': {
    specRules: ['§2.1.2'],
    specVerdict: 'stricter_than_spec',
    notes: 'The spec allows lookup tables a sponsor can resolve; v0.1.0 does not.',
  },
  'x402-019': {
    specRules: ['§2.1.4'],
    specVerdict: 'must_reject',
  },
  'x402-020': {
    specRules: ['§1.1'],
    specVerdict: 'must_reject',
  },
  'x402-021': {
    specRules: ['§2.1.4'],
    specVerdict: 'must_reject',
  },
  'x402-022': {
    specRules: ['§1.1'],
    specVerdict: 'must_reject',
  },
  'x402-023': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
    notes:
      'Clients MUST include a Memo (§3.1). Whether a sponsor must refuse a payment without one is not stated.',
  },
  'x402-024': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes: 'Without extra.memo the spec lets Memos after the transfer repeat.',
  },
  'x402-025': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-026': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-027': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec asks for at least 16 bytes; the guard accepts exactly what the pinned SDK builds.',
  },
  'x402-028': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
    notes:
      'The spec does not state the letter case of the hex nonce (docs/FIXTURES.md, open questions).',
  },
  'x402-029': {
    specRules: ['§3.1'],
    specVerdict: 'must_reject',
  },
  'x402-030': {
    specRules: ['§3.1'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-031': {
    specRules: ['§5'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-032': {
    specRules: ['§5.4'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-033': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-034': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-035': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-036': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-037': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-038': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-039': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-040': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-041': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-042': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-043': {
    specRules: ['§2.3'],
    specVerdict: 'stricter_than_spec',
  },
  'x402-044': {
    specRules: ['§1.5', '§2.2.1'],
    specVerdict: 'must_reject',
  },
  'x402-045': {
    specRules: ['§1.2'],
    specVerdict: 'must_reject',
  },
};
