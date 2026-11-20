// Core vector definitions. Expectations are written from how each message is
// built, following the rules in docs/DECISIONS.md and the build brief; they are
// never read back from the decoder.
import { type Address, AccountRole, type Instruction } from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getBatchInstruction, getTransferCheckedInstruction } from '@solana-program/token';

import type { ReasonCode, SnapshotAccount } from '@nexbridge/solana-signing-firewall';

import type { CoreVector, DecodedExpectation, Outcome } from './format.js';
import { compileLegacy, compileV0, compileV1, encode } from './messages.js';
import { type World, baseAccounts, lookupTableAccount } from './world.js';

export const NOW = '2026-11-20T00:00:00.000Z';
export const SLOT = 1000n;
export const POLICY_FILE = 'policies/fixtures-payouts.json';

const CU_LIMIT = 30_000;
const CU_PRICE_MICRO_LAMPORTS = 1_000n;
const V1_CONFIG = {
  computeUnitLimit: 30_000,
  loadedAccountsDataSizeLimit: 1_048_576,
  priorityFeeLamports: 10_000n,
};

export type Built = {
  messageVersion: CoreVector['messageVersion'];
  message: Uint8Array;
  accounts: [Address, SnapshotAccount][];
  outcome: Outcome;
  reasons: ReasonCode[];
  decoded?: DecodedExpectation;
  notes?: string;
};

export type VectorDefinition = {
  id: string;
  title: string;
  category: string;
  build: (world: World) => Built;
};

function budget(): Instruction[] {
  return [
    getSetComputeUnitLimitInstruction({ units: CU_LIMIT }),
    getSetComputeUnitPriceInstruction({ microLamports: CU_PRICE_MICRO_LAMPORTS }),
  ];
}

function transfer(world: World, destination: Address, amount: bigint) {
  return getTransferCheckedInstruction({
    source: world.treasuryAta,
    mint: world.mint,
    destination,
    authority: world.treasury,
    amount,
    decimals: 6,
  });
}

const BUDGET_INSTRUCTIONS: [string, string, string][] = [
  ['ix[0]', 'compute-budget', 'set-compute-unit-limit'],
  ['ix[1]', 'compute-budget', 'set-compute-unit-price'],
];
const FEES_FROM_INSTRUCTIONS: DecodedExpectation['fees'] = {
  source: 'instructions',
  computeUnitLimit: CU_LIMIT,
  computeUnitPriceMicroLamports: CU_PRICE_MICRO_LAMPORTS.toString(),
};
const FEES_FROM_CONFIG: DecodedExpectation['fees'] = {
  source: 'transactionConfig',
  computeUnitLimit: V1_CONFIG.computeUnitLimit,
  loadedAccountsDataSizeLimit: V1_CONFIG.loadedAccountsDataSizeLimit,
  heapSize: null,
  priorityFeeLamports: V1_CONFIG.priorityFeeLamports.toString(),
};

function expectation(
  world: World,
  version: DecodedExpectation['version'],
  instructions: [string, string, string][],
  transfers: [string, Address, bigint][],
  fees: DecodedExpectation['fees'],
  lookupTableEntries: DecodedExpectation['lookupTableEntries'] = [],
): DecodedExpectation {
  return {
    version,
    feePayer: world.treasury.address,
    requiredSigners: [world.treasury.address],
    lifetime: 'blockhash',
    instructions: instructions.map(([path, program, type]) => ({ path, program, type })),
    transfers: transfers.map(([path, destination, amount]) => ({
      path,
      source: world.treasuryAta,
      mint: world.mint,
      destination,
      authority: world.treasury.address,
      amount: amount.toString(),
      decimals: 6,
    })),
    fees,
    lookupTableEntries,
  };
}

function legacyTransfer(world: World, destination: Address, amount: bigint) {
  return compileLegacy(world.treasury.address, [...budget(), transfer(world, destination, amount)]);
}

function v0LookupTransfer(world: World) {
  return compileV0(
    world.treasury.address,
    [...budget(), transfer(world, world.vendorBAta, 1_500_000n)],
    {
      [world.lookupTable]: [world.mint, world.vendorBAta],
    },
  );
}

function batchOf(world: World) {
  return getBatchInstruction([
    transfer(world, world.vendorAAta, 400_000n),
    transfer(world, world.vendorBAta, 600_000n),
  ]);
}

function withLookupTable(world: World): [Address, SnapshotAccount][] {
  return [
    ...baseAccounts(world),
    [world.lookupTable, lookupTableAccount([world.mint, world.vendorBAta])],
  ];
}

const malformed = (
  messageVersion: CoreVector['messageVersion'],
  message: Uint8Array,
  world: World,
  notes?: string,
): Built => ({
  messageVersion,
  message,
  accounts: baseAccounts(world),
  outcome: 'deny',
  reasons: ['MALFORMED_MESSAGE'],
  ...(notes === undefined ? {} : { notes }),
});

export const CORE_VECTORS: VectorDefinition[] = [
  {
    id: 'core-001',
    title: 'Legacy TransferChecked of 1.00 USDC to vendor A',
    category: 'allow',
    build: (w) => ({
      messageVersion: 'legacy',
      message: encode(legacyTransfer(w, w.vendorAAta, 1_000_000n)),
      accounts: baseAccounts(w),
      outcome: 'allow',
      reasons: [],
      decoded: expectation(
        w,
        'legacy',
        [...BUDGET_INSTRUCTIONS, ['ix[2]', 'spl-token', 'transfer-checked']],
        [['ix[2]', w.vendorAAta, 1_000_000n]],
        FEES_FROM_INSTRUCTIONS,
      ),
    }),
  },
  {
    id: 'core-002',
    title:
      'v0 TransferChecked of 1.50 USDC to vendor B, mint and destination loaded from a lookup table',
    category: 'allow',
    build: (w) => ({
      messageVersion: 'v0',
      message: encode(v0LookupTransfer(w)),
      accounts: withLookupTable(w),
      outcome: 'allow',
      reasons: [],
      decoded: expectation(
        w,
        'v0',
        [...BUDGET_INSTRUCTIONS, ['ix[2]', 'spl-token', 'transfer-checked']],
        [['ix[2]', w.vendorBAta, 1_500_000n]],
        FEES_FROM_INSTRUCTIONS,
        [
          { table: w.lookupTable, index: 1, address: w.vendorBAta, writable: true },
          { table: w.lookupTable, index: 0, address: w.mint, writable: false },
        ],
      ),
    }),
  },
  {
    id: 'core-003',
    title: 'v1 TransferChecked of 0.50 USDC to vendor A, fees in transactionConfig',
    category: 'allow',
    build: (w) => ({
      messageVersion: 'v1',
      message: encode(
        compileV1(w.treasury.address, [transfer(w, w.vendorAAta, 500_000n)], V1_CONFIG),
      ),
      accounts: baseAccounts(w),
      outcome: 'allow',
      reasons: [],
      decoded: expectation(
        w,
        'v1',
        [['ix[0]', 'spl-token', 'transfer-checked']],
        [['ix[0]', w.vendorAAta, 500_000n]],
        FEES_FROM_CONFIG,
      ),
    }),
  },
  {
    id: 'core-004',
    title: 'P-Token batch: 0.40 USDC to vendor A and 0.60 USDC to vendor B in one instruction',
    category: 'allow',
    build: (w) => ({
      messageVersion: 'legacy',
      message: encode(compileLegacy(w.treasury.address, [...budget(), batchOf(w)])),
      accounts: baseAccounts(w),
      outcome: 'allow',
      reasons: [],
      decoded: expectation(
        w,
        'legacy',
        [...BUDGET_INSTRUCTIONS, ['ix[2]', 'spl-token', 'batch']],
        [
          ['ix[2].batch[0]', w.vendorAAta, 400_000n],
          ['ix[2].batch[1]', w.vendorBAta, 600_000n],
        ],
        FEES_FROM_INSTRUCTIONS,
      ),
    }),
  },
  {
    id: 'core-005',
    title:
      'Legacy TransferChecked of 3.00 USDC to vendor B, above the approval threshold, no approval',
    category: 'needs-approval',
    build: (w) => ({
      messageVersion: 'legacy',
      message: encode(legacyTransfer(w, w.vendorBAta, 3_000_000n)),
      accounts: baseAccounts(w),
      outcome: 'needs_approval',
      reasons: [],
      decoded: expectation(
        w,
        'legacy',
        [...BUDGET_INSTRUCTIONS, ['ix[2]', 'spl-token', 'transfer-checked']],
        [['ix[2]', w.vendorBAta, 3_000_000n]],
        FEES_FROM_INSTRUCTIONS,
      ),
    }),
  },
  {
    id: 'core-006',
    title: 'Version byte 0x82 (a message version that does not exist)',
    category: 'malformed',
    build: (w) => {
      const message = encode(v0LookupTransfer(w));
      message[0] = 0x82;
      return {
        messageVersion: 'unsupported',
        message,
        accounts: withLookupTable(w),
        outcome: 'deny',
        reasons: ['UNSUPPORTED_VERSION'],
      };
    },
  },
  {
    id: 'core-007',
    title: 'Legacy message truncated inside its last instruction',
    category: 'malformed',
    build: (w) =>
      malformed('legacy', encode(legacyTransfer(w, w.vendorAAta, 1_000_000n)).slice(0, -7), w),
  },
  {
    id: 'core-008',
    title: 'Instruction refers to account index 99, which does not exist',
    category: 'malformed',
    build: (w) => {
      const compiled = legacyTransfer(w, w.vendorAAta, 1_000_000n);
      const instructions = compiled.instructions.map((ix, i) =>
        i === 2
          ? { ...ix, accountIndices: (ix.accountIndices ?? []).map((a, j) => (j === 2 ? 99 : a)) }
          : ix,
      );
      return malformed('legacy', encode({ ...compiled, instructions }), w);
    },
  },
  {
    id: 'core-009',
    title: 'Batch whose last entry declares 10 data bytes but only 6 remain',
    category: 'malformed',
    build: (w) => {
      const batch = batchOf(w);
      const truncated = { ...batch, data: batch.data.slice(0, -4) };
      return malformed(
        'legacy',
        encode(compileLegacy(w.treasury.address, [...budget(), truncated])),
        w,
      );
    },
  },
  {
    id: 'core-010',
    title: 'Batch whose first entry claims 5 accounts, leaving too few for the second entry',
    category: 'malformed',
    build: (w) => {
      const batch = batchOf(w);
      const data = new Uint8Array(batch.data);
      data[1] = 5;
      return malformed(
        'legacy',
        encode(compileLegacy(w.treasury.address, [...budget(), { ...batch, data }])),
        w,
      );
    },
  },
  {
    id: 'core-011',
    title: 'Batch with an extra account that no entry uses',
    category: 'malformed',
    build: (w) => {
      const batch = batchOf(w);
      const extra = {
        ...batch,
        accounts: [...batch.accounts, { address: w.outsider, role: AccountRole.READONLY }],
      };
      return malformed(
        'legacy',
        encode(compileLegacy(w.treasury.address, [...budget(), extra])),
        w,
        'Stricter than the program: P-Token ignores accounts that no batch entry consumes.',
      );
    },
  },
  {
    id: 'core-012',
    title: 'Valid legacy message followed by one extra byte',
    category: 'malformed',
    build: (w) =>
      malformed(
        'legacy',
        new Uint8Array([...encode(legacyTransfer(w, w.vendorAAta, 1_000_000n)), 0]),
        w,
      ),
  },
  {
    id: 'core-013',
    title: 'v1 message that lists the same account twice',
    category: 'malformed',
    build: (w) => {
      const compiled = compileV1(
        w.treasury.address,
        [transfer(w, w.vendorAAta, 500_000n)],
        V1_CONFIG,
      );
      const duplicated = {
        ...compiled,
        staticAccounts: [...compiled.staticAccounts, w.vendorAAta],
        numStaticAccounts: compiled.numStaticAccounts + 1,
        header: {
          ...compiled.header,
          numReadonlyNonSignerAccounts: compiled.header.numReadonlyNonSignerAccounts + 1,
        },
      };
      return malformed('v1', encode(duplicated), w);
    },
  },
  {
    id: 'core-014',
    title: 'v1 transactionConfig mask that sets only one of the two priority-fee bits',
    category: 'malformed',
    build: (w) => {
      const message = encode(
        compileV1(w.treasury.address, [transfer(w, w.vendorAAta, 500_000n)], {
          computeUnitLimit: V1_CONFIG.computeUnitLimit,
          loadedAccountsDataSizeLimit: V1_CONFIG.loadedAccountsDataSizeLimit,
        }),
      );
      // Bytes 4..7 hold the mask. Bits 2 and 3 are set; replace with bits 0 and 2 (same value count).
      new DataView(message.buffer).setUint32(4, 0b0101, true);
      return malformed('v1', message, w);
    },
  },
  {
    id: 'core-015',
    title: 'v0 message whose lookup table is not in the snapshot',
    category: 'lookup-table',
    build: (w) => ({
      messageVersion: 'v0',
      message: encode(v0LookupTransfer(w)),
      accounts: baseAccounts(w),
      outcome: 'deny',
      reasons: ['LOOKUP_TABLE_UNRESOLVED'],
    }),
  },
];
