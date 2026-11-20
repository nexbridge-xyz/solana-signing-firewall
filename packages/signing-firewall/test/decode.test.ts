import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type Address,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getAdvanceNonceAccountInstruction } from '@solana-program/system';
import {
  getApproveInstruction,
  getBatchInstruction,
  getBatchInstructionDataDecoder,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { getTransferCheckedInstruction as getTransferChecked2022 } from '@solana-program/token-2022';

import {
  SPL_MEMO_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  decodeCompiledMessage,
  decodeTransactionMessage,
  detectMessageVersion,
  parseTokenBatch,
} from '../src/index.js';
import {
  BLOCKHASH,
  addresses,
  emptySnapshot,
  legacyMessage,
  lookupTableAccount,
  snapshotWith,
  v0Message,
  v1Message,
} from './helpers.js';

const [treasury, mint, source, vendorA, vendorB, table, nonceAccount] = (await addresses(7)) as [
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
  Address,
];

function transfer(destination: Address, amount: bigint) {
  return getTransferCheckedInstruction({
    source,
    mint,
    destination,
    authority: treasury,
    amount,
    decimals: 6,
  });
}

function reasonsOf(result: ReturnType<typeof decodeTransactionMessage>): string[] {
  return result.ok ? [] : result.reasons.map((r) => r.code);
}

describe('detectMessageVersion', () => {
  it.each([
    [[0x01], 'legacy'],
    [[0x7f], 'legacy'],
    [[0x80], 'v0'],
    [[0x81], 'v1'],
  ])('reads %j as %s', (bytes, version) => {
    expect(detectMessageVersion(new Uint8Array(bytes))).toEqual({ ok: true, value: version });
  });

  it.each([[0x82], [0xff]])('rejects version byte %i as UNSUPPORTED_VERSION', (byte) => {
    const result = detectMessageVersion(new Uint8Array([byte, 0, 0]));
    expect(result.ok ? [] : result.reasons.map((r) => r.code)).toEqual(['UNSUPPORTED_VERSION']);
  });

  it('rejects an empty message as MALFORMED_MESSAGE', () => {
    const result = detectMessageVersion(new Uint8Array());
    expect(result.ok ? [] : result.reasons.map((r) => r.code)).toEqual(['MALFORMED_MESSAGE']);
  });
});

describe('decodeTransactionMessage', () => {
  it('decodes a legacy transfer with compute-budget instructions', () => {
    const { bytes } = legacyMessage(treasury, [
      getSetComputeUnitLimitInstruction({ units: 50_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
      transfer(vendorA, 1_000_000n),
    ]);
    const result = decodeTransactionMessage(bytes, emptySnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = result.value;
    expect(decoded.version).toBe('legacy');
    expect(decoded.feePayer).toBe(treasury);
    expect(decoded.requiredSigners).toEqual([treasury]);
    expect(decoded.lifetime).toEqual({ type: 'blockhash', token: BLOCKHASH });
    expect(decoded.fees).toEqual({
      source: 'instructions',
      computeUnitLimit: 50_000,
      computeUnitPriceMicroLamports: 1_000n,
    });
    expect(decoded.transfers).toEqual([
      {
        path: 'ix[2]',
        source,
        mint,
        destination: vendorA,
        authority: treasury,
        multisigSigners: [],
        amount: 1_000_000n,
        decimals: 6,
      },
    ]);
  });

  it('resolves a v0 transfer whose accounts come from a lookup table', () => {
    const { bytes } = v0Message(treasury, [transfer(vendorB, 1_500_000n)], {
      [table]: [mint, vendorB, source],
    });
    const snapshot = snapshotWith([[table, lookupTableAccount([mint, vendorB, source])]]);
    const result = decodeTransactionMessage(bytes, snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('v0');
    expect(result.value.transfers[0]).toMatchObject({
      source,
      mint,
      destination: vendorB,
      amount: 1_500_000n,
    });
    expect(result.value.lookupTableEntries.map((e) => [e.index, e.address, e.writable])).toEqual(
      expect.arrayContaining([
        [0, mint, false],
        [1, vendorB, true],
        [2, source, true],
      ]),
    );
  });

  it('reads v1 fees from transactionConfig only', () => {
    const { bytes } = v1Message(treasury, [transfer(vendorA, 500_000n)], {
      computeUnitLimit: 200_000,
      loadedAccountsDataSizeLimit: 1_048_576,
      priorityFeeLamports: 10_000n,
    });
    const result = decodeTransactionMessage(bytes, emptySnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe('v1');
    expect(result.value.fees).toEqual({
      source: 'transactionConfig',
      computeUnitLimit: 200_000,
      loadedAccountsDataSizeLimit: 1_048_576,
      heapSize: undefined,
      priorityFeeLamports: 10_000n,
    });
  });

  it('places the v1 config mask at bytes 4..7 as SIMD-0385 specifies', () => {
    const { bytes } = v1Message(treasury, [transfer(vendorA, 1n)], {
      computeUnitLimit: 1,
      priorityFeeLamports: 1n,
    });
    expect(bytes[0]).toBe(0x81);
    expect([...bytes.slice(4, 8)]).toEqual([0b111, 0, 0, 0]);
  });

  it.each([
    ['only one priority-fee bit', 0b101],
    ['an unknown bit', 0b1_0000_0100],
  ])('rejects a v1 mask with %s', (_label, mask) => {
    const { bytes } = v1Message(treasury, [transfer(vendorA, 1n)], {
      computeUnitLimit: 1,
      loadedAccountsDataSizeLimit: 1,
    });
    const mutated = new Uint8Array(bytes);
    new DataView(mutated.buffer).setUint32(4, mask, true);
    expect(reasonsOf(decodeTransactionMessage(mutated, emptySnapshot()))).toEqual([
      'MALFORMED_MESSAGE',
    ]);
  });

  it('rejects trailing bytes and truncation', () => {
    const { bytes } = legacyMessage(treasury, [transfer(vendorA, 1n)]);
    const longer = new Uint8Array([...bytes, 0]);
    const shorter = bytes.slice(0, bytes.length - 3);
    expect(reasonsOf(decodeTransactionMessage(longer, emptySnapshot()))).toEqual([
      'MALFORMED_MESSAGE',
    ]);
    expect(reasonsOf(decodeTransactionMessage(shorter, emptySnapshot()))).toEqual([
      'MALFORMED_MESSAGE',
    ]);
  });

  describe('sanitization', () => {
    const base = pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(treasury, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
          m,
        ),
      (m) => appendTransactionMessageInstructions([transfer(vendorA, 1n)], m),
    );
    const compiled = compileTransactionMessage(base);
    const encode = (value: typeof compiled) =>
      new Uint8Array(getCompiledTransactionMessageEncoder().encode(value));
    const ix = compiled.instructions[0];
    if (ix === undefined) throw new Error('fixture has no instruction');

    it('rejects an account index out of range', () => {
      const bad = { ...compiled, instructions: [{ ...ix, accountIndices: [0, 1, 99, 0] }] };
      const result = decodeCompiledMessage(encode(bad));
      expect(result.ok ? '' : result.reasons[0]?.detail).toMatch(
        /account index 99 is out of range/,
      );
    });

    it('rejects the fee payer used as a program', () => {
      const bad = { ...compiled, instructions: [{ ...ix, programAddressIndex: 0 }] };
      const result = decodeCompiledMessage(encode(bad));
      expect(result.ok ? '' : result.reasons[0]?.detail).toMatch(/fee payer cannot be a program/);
    });

    it('rejects a duplicate static account', () => {
      const bad = { ...compiled, staticAccounts: [...compiled.staticAccounts, treasury] };
      const result = decodeCompiledMessage(encode(bad));
      expect(result.ok ? '' : result.reasons[0]?.detail).toMatch(/duplicate static account/);
    });

    it('rejects a header whose fee payer would be read-only', () => {
      const bad = { ...compiled, header: { ...compiled.header, numReadonlySignerAccounts: 1 } };
      const result = decodeCompiledMessage(encode(bad));
      expect(result.ok ? '' : result.reasons[0]?.detail).toMatch(/fee payer would be read-only/);
    });
  });

  describe('lookup tables', () => {
    const { bytes } = v0Message(treasury, [transfer(vendorB, 1n)], { [table]: [vendorB] });

    it.each([
      ['missing from the snapshot', emptySnapshot()],
      [
        'owned by another program',
        snapshotWith([[table, { ...lookupTableAccount([vendorB]), owner: TOKEN_PROGRAM_ADDRESS }]]),
      ],
      [
        'deactivated',
        snapshotWith([[table, lookupTableAccount([vendorB], { deactivationSlot: 50n })]]),
      ],
      [
        'extended in the snapshot slot',
        snapshotWith([[table, lookupTableAccount([vendorB], { lastExtendedSlot: 100n })]], 100n),
      ],
    ])('is unresolved when %s', (_label, snapshot) => {
      expect(reasonsOf(decodeTransactionMessage(bytes, snapshot))).toEqual([
        'LOOKUP_TABLE_UNRESOLVED',
      ]);
    });

    it('resolves entries extended in an earlier slot', () => {
      const snapshot = snapshotWith(
        [[table, lookupTableAccount([vendorB], { lastExtendedSlot: 99n })]],
        100n,
      );
      expect(decodeTransactionMessage(bytes, snapshot).ok).toBe(true);
    });
  });

  describe('instruction classification', () => {
    it('reports each batch entry with its path', () => {
      const { bytes } = legacyMessage(treasury, [
        getBatchInstruction([transfer(vendorA, 400_000n), transfer(vendorB, 600_000n)]),
      ]);
      const result = decodeTransactionMessage(bytes, emptySnapshot());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.transfers.map((t) => [t.path, t.destination, t.amount])).toEqual([
        ['ix[0].batch[0]', vendorA, 400_000n],
        ['ix[0].batch[1]', vendorB, 600_000n],
      ]);
    });

    it('names a non-transfer entry inside a batch', () => {
      const { bytes } = legacyMessage(treasury, [
        getBatchInstruction([
          transfer(vendorA, 1n),
          getApproveInstruction({ source, delegate: vendorB, owner: treasury, amount: 5n }),
        ]),
      ]);
      const result = decodeTransactionMessage(bytes, emptySnapshot());
      if (!result.ok) throw new Error('expected decode');
      const ix = result.value.instructions[0];
      expect(
        ix?.program === 'spl-token' && ix.token.type === 'batch' ? ix.token.entries[1] : undefined,
      ).toEqual({
        path: 'ix[0].batch[1]',
        instruction: { type: 'other', name: 'Approve' },
      });
    });

    it('treats a truncated batch as MALFORMED_MESSAGE', () => {
      const batch = getBatchInstruction([transfer(vendorA, 1n)]);
      const { bytes } = legacyMessage(treasury, [{ ...batch, data: batch.data.slice(0, -2) }]);
      expect(reasonsOf(decodeTransactionMessage(bytes, emptySnapshot()))).toEqual([
        'MALFORMED_MESSAGE',
      ]);
    });

    it('marks a durable-nonce lifetime', () => {
      const { bytes } = legacyMessage(treasury, [
        getAdvanceNonceAccountInstruction({
          nonceAccount,
          nonceAuthority: createNoopSigner(treasury),
        }),
        transfer(vendorA, 1n),
      ]);
      const result = decodeTransactionMessage(bytes, emptySnapshot());
      if (!result.ok) throw new Error('expected decode');
      expect(result.value.lifetime.type).toBe('nonce');
      expect(result.value.instructions[0]).toMatchObject({
        program: 'system',
        advancesNonce: true,
      });
    });

    it('separates Token-2022 and memo instructions', () => {
      const { bytes } = legacyMessage(treasury, [
        getTransferChecked2022({
          source,
          mint,
          destination: vendorA,
          authority: treasury,
          amount: 1n,
          decimals: 6,
        }),
        {
          programAddress: SPL_MEMO_PROGRAM_ADDRESS,
          accounts: [{ address: treasury, role: AccountRole.READONLY_SIGNER }],
          data: new TextEncoder().encode('invoice 7'),
        },
      ]);
      const result = decodeTransactionMessage(bytes, emptySnapshot());
      if (!result.ok) throw new Error('expected decode');
      expect(result.value.instructions.map((ix) => ix.program)).toEqual(['token-2022', 'memo']);
      expect(result.value.transfers).toEqual([]);
    });
  });
});

describe('parseTokenBatch', () => {
  it('agrees with the official batch data codec on a real batch', () => {
    const batch = getBatchInstruction([transfer(vendorA, 400_000n), transfer(vendorB, 600_000n)]);
    const ours = parseTokenBatch(new Uint8Array(batch.data), batch.accounts.length);
    const theirs = getBatchInstructionDataDecoder().decode(batch.data).data;
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    expect(ours.entries.map((e) => [e.accountCount, [...e.data]])).toEqual(
      theirs.map((e) => [e.numberOfAccounts, [...e.instructionData]]),
    );
  });

  it.each([
    ['an empty batch', [255], 0, /empty batch/],
    ['a truncated entry header', [255, 1], 1, /truncated header/],
    ['an entry with no data', [255, 0, 0], 0, /no data/],
    ['truncated entry data', [255, 1, 5, 12, 0], 1, /declares 5 data bytes, 2 remain/],
    ['more accounts than the instruction has', [255, 4, 1, 12], 3, /needs 4 accounts, 3 remain/],
    ['accounts no entry uses', [255, 1, 1, 12], 2, /1 of 2 accounts are not used/],
  ])('rejects %s', (_label, data, accounts, detail) => {
    const result = parseTokenBatch(new Uint8Array(data), accounts);
    expect(result.ok ? '' : result.detail).toMatch(detail);
  });

  it('agrees with the official codec on random well-formed batches', () => {
    const entry = fc.record({
      accountCount: fc.integer({ min: 0, max: 6 }),
      data: fc.uint8Array({ minLength: 1, maxLength: 40 }),
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        const data = new Uint8Array([
          255,
          ...entries.flatMap((e) => [e.accountCount, e.data.length, ...e.data]),
        ]);
        const accounts = entries.reduce((sum, e) => sum + e.accountCount, 0);
        const ours = parseTokenBatch(data, accounts);
        const theirs = getBatchInstructionDataDecoder().decode(data).data;
        expect(ours.ok).toBe(true);
        if (!ours.ok) return;
        expect(ours.entries.map((e) => [e.accountCount, [...e.data]])).toEqual(
          theirs.map((e) => [e.numberOfAccounts, [...e.instructionData]]),
        );
      }),
    );
  });
});

describe('robustness', () => {
  const allowed = new Set(['MALFORMED_MESSAGE', 'UNSUPPORTED_VERSION', 'LOOKUP_TABLE_UNRESOLVED']);
  const valid = [
    legacyMessage(treasury, [transfer(vendorA, 1n)]).bytes,
    v0Message(treasury, [transfer(vendorB, 1n)], { [table]: [vendorB] }).bytes,
    v1Message(treasury, [transfer(vendorA, 1n)], {
      computeUnitLimit: 1,
      loadedAccountsDataSizeLimit: 1,
    }).bytes,
  ];

  it('never throws on random bytes', () => {
    const versioned = fc
      .tuple(fc.constantFrom(0x80, 0x81), fc.uint8Array({ maxLength: 400 }))
      .map(([v, rest]) => new Uint8Array([v, ...rest]));
    fc.assert(
      fc.property(fc.oneof(fc.uint8Array({ maxLength: 400 }), versioned), (bytes) => {
        const result = decodeTransactionMessage(bytes, emptySnapshot());
        if (!result.ok) expect(result.reasons.every((r) => allowed.has(r.code))).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });

  it('never throws on mutated valid messages', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...valid),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        fc.nat(),
        (bytes, edits, cut) => {
          const mutated = new Uint8Array(bytes);
          for (const [position, value] of edits) mutated[position % mutated.length] = value;
          const result = decodeTransactionMessage(
            mutated.slice(0, cut % (mutated.length + 1)),
            emptySnapshot(),
          );
          if (!result.ok) expect(result.reasons.every((r) => allowed.has(r.code))).toBe(true);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
