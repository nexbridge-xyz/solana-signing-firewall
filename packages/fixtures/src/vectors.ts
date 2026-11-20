// Core vector definitions. Expectations are written from how each message is
// built, following docs/DECISIONS.md and the build brief; they are never read
// back from the code under test. Runtime verdicts are confirmed in LiteSVM by
// test/litesvm-vectors.test.ts wherever `runtimeCheckedBy` is `litesvm`.
import { createHash } from 'node:crypto';

import {
  type Address,
  AccountRole,
  type Instruction,
  getBase58Decoder,
  getBase58Encoder,
} from '@solana/kit';
import {
  getRequestHeapFrameInstruction,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { MEMO_PROGRAM_ADDRESS as NEWER_MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  AccountState,
  AuthorityType,
  getApproveInstruction,
  getBatchInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from '@solana-program/token';
import { getTransferCheckedInstruction as getTransferChecked2022 } from '@solana-program/token-2022';

import {
  type ApprovalRecord,
  type ReasonCode,
  SPL_MEMO_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  type SnapshotAccount,
  TOKEN_2022_PROGRAM_ADDRESS,
  canonicalDigest,
  createApproval,
} from '@nexbridge/solana-signing-firewall';

import type { CoreVector, DecodedExpectation, Outcome } from './format.js';
import {
  FIXED_BLOCKHASH,
  compileLegacy,
  compileLegacyWithNonce,
  compileV0,
  compileV1,
  encode,
} from './messages.js';
import {
  type PolicyName,
  type World,
  baseAccounts,
  lookupTableAccount,
  mintAccount,
  nonceAccount,
  payoutsPolicy,
  policyJson,
  tokenAccount,
} from './world.js';

export const NOW = '2026-11-20T00:00:00.000Z';
export const SLOT = 1000n;
const NOW_MS = Date.parse(NOW);

const CU_LIMIT = 30_000;
const CU_PRICE_MICRO_LAMPORTS = 1_000n;
const V1_CONFIG = {
  computeUnitLimit: 30_000,
  loadedAccountsDataSizeLimit: 1_048_576,
  priorityFeeLamports: 10_000n,
};

type Accounts = [Address, SnapshotAccount | null][];
type RuntimeVerdict = CoreVector['runtimeVerdict'];

export type Built = {
  messageVersion: CoreVector['messageVersion'];
  message: Uint8Array;
  accounts: Accounts;
  policy: PolicyName;
  outcome: Outcome;
  reasons: ReasonCode[];
  runtimeVerdict: RuntimeVerdict;
  runtimeCheckedBy: CoreVector['runtimeCheckedBy'];
  approval?: ApprovalRecord;
  approvalReasons?: ReasonCode[];
  decoded?: DecodedExpectation;
  notes?: string;
};

export type VectorDefinition = {
  id: string;
  title: string;
  category: string;
  build: (world: World) => Built | Promise<Built>;
};

// ---------------------------------------------------------------- builders

function budget(units = CU_LIMIT, microLamports = CU_PRICE_MICRO_LAMPORTS): Instruction[] {
  return [
    getSetComputeUnitLimitInstruction({ units }),
    getSetComputeUnitPriceInstruction({ microLamports }),
  ];
}

type PayOptions = {
  source?: Address;
  mint?: Address;
  decimals?: number;
  authority?: World['treasury'];
  multiSigners?: World['treasury'][];
};

function pay(w: World, destination: Address, amount: bigint, options: PayOptions = {}) {
  return getTransferCheckedInstruction({
    source: options.source ?? w.treasuryAta,
    mint: options.mint ?? w.mint,
    destination,
    authority: options.authority ?? w.treasury,
    amount,
    decimals: options.decimals ?? 6,
    ...(options.multiSigners === undefined ? {} : { multiSigners: options.multiSigners }),
  });
}

function memo(w: World, text: string, program: Address = SPL_MEMO_PROGRAM_ADDRESS): Instruction {
  return {
    programAddress: program,
    accounts: [{ address: w.treasury.address, role: AccountRole.READONLY_SIGNER }],
    data: new TextEncoder().encode(text),
  };
}

const legacy = (w: World, instructions: Instruction[], feePayer: Address = w.treasury.address) =>
  encode(compileLegacy(feePayer, instructions));

function withAccount(
  accounts: Accounts,
  address: Address,
  account: SnapshotAccount | null,
): Accounts {
  return [...accounts.filter(([key]) => key !== address), [address, account]];
}

function withoutAccount(accounts: Accounts, address: Address): Accounts {
  return accounts.filter(([key]) => key !== address);
}

function v0LookupTransfer(w: World) {
  return compileV0(w.treasury.address, [...budget(), pay(w, w.vendorBAta, 1_500_000n)], {
    [w.lookupTable]: [w.mint, w.vendorBAta],
  });
}

function withLookupTable(w: World): Accounts {
  return [...baseAccounts(w), [w.lookupTable, lookupTableAccount([w.mint, w.vendorBAta])]];
}

function batchOf(w: World) {
  return getBatchInstruction([pay(w, w.vendorAAta, 400_000n), pay(w, w.vendorBAta, 600_000n)]);
}

type Outcomeish = Pick<Built, 'outcome' | 'reasons'>;
const allow: Outcomeish = { outcome: 'allow', reasons: [] };
const needsApproval: Outcomeish = { outcome: 'needs_approval', reasons: [] };
const deny = (...reasons: ReasonCode[]): Outcomeish => ({ outcome: 'deny', reasons });

/** A legacy vector against the main policy, with the base accounts, checked in LiteSVM. */
function legacyVector(
  w: World,
  instructions: Instruction[],
  expectation: Outcomeish,
  runtimeVerdict: RuntimeVerdict,
  extra: Partial<Built> = {},
): Built {
  return {
    messageVersion: 'legacy',
    message: legacy(w, instructions),
    accounts: baseAccounts(w),
    policy: 'payouts',
    runtimeVerdict,
    runtimeCheckedBy: 'litesvm',
    ...expectation,
    ...extra,
  };
}

function malformed(
  w: World,
  messageVersion: CoreVector['messageVersion'],
  message: Uint8Array,
  runtimeVerdict: RuntimeVerdict = 'runtime_rejects',
  notes?: string,
): Built {
  return {
    messageVersion,
    message,
    accounts: baseAccounts(w),
    policy: 'payouts',
    ...deny('MALFORMED_MESSAGE'),
    runtimeVerdict,
    runtimeCheckedBy: 'litesvm',
    ...(notes === undefined ? {} : { notes }),
  };
}

/** LiteSVM 1.6.2 aborts the process on bytes it cannot deserialize, so it cannot judge these. */
const UNDESERIALIZABLE =
  'Not checked in LiteSVM: LiteSVM 1.6.2 aborts on bytes it cannot deserialize. The runtime refuses them.';

function notDeserializable(built: Built, reason: string): Built {
  return { ...built, runtimeCheckedBy: 'not_checked', notes: `${reason} ${UNDESERIALIZABLE}` };
}

// ---------------------------------------------------------------- expectations of decoded facts

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

function decodedFacts(
  w: World,
  version: DecodedExpectation['version'],
  instructions: [string, string, string][],
  transfers: [string, Address, bigint][],
  fees: DecodedExpectation['fees'],
  lookupTableEntries: DecodedExpectation['lookupTableEntries'] = [],
): DecodedExpectation {
  return {
    version,
    feePayer: w.treasury.address,
    requiredSigners: [w.treasury.address],
    lifetime: 'blockhash',
    instructions: instructions.map(([path, program, type]) => ({ path, program, type })),
    transfers: transfers.map(([path, destination, amount]) => ({
      path,
      source: w.treasuryAta,
      mint: w.mint,
      destination,
      authority: w.treasury.address,
      amount: amount.toString(),
      decimals: 6,
    })),
    fees,
    lookupTableEntries,
  };
}

// ---------------------------------------------------------------- approvals

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function approvalFor(
  w: World,
  message: Uint8Array,
  options: {
    approver?: World['treasury'];
    issuedOffsetSeconds?: number;
    lifetimeSeconds?: number;
    policy?: unknown;
  } = {},
): Promise<ApprovalRecord> {
  const issuedAt = new Date(NOW_MS + (options.issuedOffsetSeconds ?? -30) * 1000);
  return createApproval({
    decision: {
      messageDigest: sha256Hex(message),
      policyDigest: canonicalDigest(options.policy ?? payoutsPolicy(w)),
    },
    approver: options.approver ?? w.approver,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + (options.lifetimeSeconds ?? 90) * 1000),
  });
}

function approvalVector(
  w: World,
  message: Uint8Array,
  approval: ApprovalRecord,
  approvalReasons: ReasonCode[],
): Built {
  return {
    messageVersion: 'legacy',
    message,
    accounts: baseAccounts(w),
    policy: 'payouts',
    ...needsApproval,
    approval,
    approvalReasons,
    runtimeVerdict: 'runtime_accepts',
    runtimeCheckedBy: 'litesvm',
  };
}

const transfer300 = (w: World) => legacy(w, [...budget(), pay(w, w.vendorBAta, 3_000_000n)]);

// ---------------------------------------------------------------- definitions

export const CORE_VECTORS: VectorDefinition[] = [
  // ---- allowed messages, one per format
  {
    id: 'core-001',
    title: 'Legacy TransferChecked of 1.00 USDC to vendor A',
    category: 'allow',
    build: (w) =>
      legacyVector(w, [...budget(), pay(w, w.vendorAAta, 1_000_000n)], allow, 'runtime_accepts', {
        decoded: decodedFacts(
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
      policy: 'payouts',
      ...allow,
      runtimeVerdict: 'runtime_accepts',
      runtimeCheckedBy: 'litesvm',
      decoded: decodedFacts(
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
      message: encode(compileV1(w.treasury.address, [pay(w, w.vendorAAta, 500_000n)], V1_CONFIG)),
      accounts: baseAccounts(w),
      policy: 'payouts',
      ...allow,
      runtimeVerdict: 'runtime_accepts',
      runtimeCheckedBy: 'litesvm',
      decoded: decodedFacts(
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
    build: (w) =>
      legacyVector(w, [...budget(), batchOf(w)], allow, 'runtime_accepts', {
        decoded: decodedFacts(
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
    category: 'approval',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorBAta, 3_000_000n)],
        needsApproval,
        'runtime_accepts',
        {
          approvalReasons: ['APPROVAL_REQUIRED'],
          decoded: decodedFacts(
            w,
            'legacy',
            [...BUDGET_INSTRUCTIONS, ['ix[2]', 'spl-token', 'transfer-checked']],
            [['ix[2]', w.vendorBAta, 3_000_000n]],
            FEES_FROM_INSTRUCTIONS,
          ),
        },
      ),
  },

  // ---- malformed input
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
        policy: 'payouts',
        ...deny('UNSUPPORTED_VERSION'),
        runtimeVerdict: 'runtime_rejects',
        runtimeCheckedBy: 'not_checked',
        notes: `No message version 2 exists. ${UNDESERIALIZABLE}`,
      };
    },
  },
  {
    id: 'core-007',
    title: 'Legacy message truncated inside its last instruction',
    category: 'malformed',
    build: (w) =>
      notDeserializable(
        malformed(
          w,
          'legacy',
          legacy(w, [...budget(), pay(w, w.vendorAAta, 1_000_000n)]).slice(0, -7),
        ),
        'The message ends inside an instruction.',
      ),
  },
  {
    id: 'core-008',
    title: 'Instruction refers to account index 99, which does not exist',
    category: 'malformed',
    build: (w) => {
      const compiled = compileLegacy(w.treasury.address, [
        ...budget(),
        pay(w, w.vendorAAta, 1_000_000n),
      ]);
      const instructions = compiled.instructions.map((ix, i) =>
        i === 2
          ? { ...ix, accountIndices: (ix.accountIndices ?? []).map((a, j) => (j === 2 ? 99 : a)) }
          : ix,
      );
      return malformed(w, 'legacy', encode({ ...compiled, instructions }));
    },
  },
  {
    id: 'core-009',
    title: 'Batch whose last entry declares 10 data bytes but only 6 remain',
    category: 'malformed',
    build: (w) => {
      const batch = batchOf(w);
      return malformed(
        w,
        'legacy',
        legacy(w, [...budget(), { ...batch, data: batch.data.slice(0, -4) }]),
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
      return malformed(w, 'legacy', legacy(w, [...budget(), { ...batch, data }]));
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
        accounts: [...batch.accounts, { address: w.outsider.address, role: AccountRole.READONLY }],
      };
      return malformed(
        w,
        'legacy',
        legacy(w, [...budget(), extra]),
        'runtime_accepts',
        'Stricter than the runtime: P-Token ignores accounts that no batch entry consumes.',
      );
    },
  },
  {
    id: 'core-012',
    title: 'Valid legacy message followed by one extra byte',
    category: 'malformed',
    build: (w) =>
      malformed(
        w,
        'legacy',
        new Uint8Array([...legacy(w, [...budget(), pay(w, w.vendorAAta, 1_000_000n)]), 0]),
      ),
  },
  {
    id: 'core-013',
    title: 'v1 message that lists the same account twice',
    category: 'malformed',
    build: (w) => {
      const compiled = compileV1(w.treasury.address, [pay(w, w.vendorAAta, 500_000n)], V1_CONFIG);
      return malformed(
        w,
        'v1',
        encode({
          ...compiled,
          staticAccounts: [...compiled.staticAccounts, w.vendorAAta],
          numStaticAccounts: compiled.numStaticAccounts + 1,
          header: {
            ...compiled.header,
            numReadonlyNonSignerAccounts: compiled.header.numReadonlyNonSignerAccounts + 1,
          },
        }),
      );
    },
  },
  {
    id: 'core-014',
    title: 'v1 transactionConfig mask that sets only one of the two priority-fee bits',
    category: 'malformed',
    build: (w) => {
      const message = encode(
        compileV1(w.treasury.address, [pay(w, w.vendorAAta, 500_000n)], {
          computeUnitLimit: V1_CONFIG.computeUnitLimit,
          loadedAccountsDataSizeLimit: V1_CONFIG.loadedAccountsDataSizeLimit,
        }),
      );
      // Bytes 4..7 hold the mask. Bits 2 and 3 are set; replace with bits 0 and 2 (same value count).
      new DataView(message.buffer).setUint32(4, 0b0101, true);
      return notDeserializable(
        malformed(w, 'v1', message),
        'SIMD-0385: a transaction with only one priority-fee bit set is invalid.',
      );
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
      policy: 'payouts',
      ...deny('LOOKUP_TABLE_UNRESOLVED'),
      runtimeVerdict: 'runtime_rejects',
      runtimeCheckedBy: 'litesvm',
    }),
  },

  // ---- approvals
  {
    id: 'core-016',
    title: '3.00 USDC to vendor B with a valid approval',
    category: 'approval',
    build: async (w) => approvalVector(w, transfer300(w), await approvalFor(w, transfer300(w)), []),
  },
  {
    id: 'core-017',
    title: '3.00 USDC to vendor B with an approval that expired 30 seconds ago',
    category: 'approval',
    build: async (w) =>
      approvalVector(
        w,
        transfer300(w),
        await approvalFor(w, transfer300(w), { issuedOffsetSeconds: -120 }),
        ['APPROVAL_EXPIRED'],
      ),
  },
  {
    id: 'core-018',
    title: '3.00 USDC to vendor B, approved by someone who is not an approver',
    category: 'approval',
    build: async (w) =>
      approvalVector(
        w,
        transfer300(w),
        await approvalFor(w, transfer300(w), { approver: w.outsider }),
        ['APPROVER_NOT_ALLOWED'],
      ),
  },
  {
    id: 'core-019',
    title: '4.50 USDC to vendor B, presented with the approval of the 3.00 USDC message',
    category: 'approval',
    build: async (w) => {
      const message = legacy(w, [...budget(), pay(w, w.vendorBAta, 4_500_000n)]);
      return approvalVector(w, message, await approvalFor(w, transfer300(w)), [
        'APPROVAL_MESSAGE_MISMATCH',
      ]);
    },
  },
  {
    id: 'core-020',
    title: '3.00 USDC to vendor B with an approval issued under an earlier version of the policy',
    category: 'approval',
    build: async (w) => ({
      ...approvalVector(
        w,
        transfer300(w),
        await approvalFor(w, transfer300(w), { policy: payoutsPolicy(w, '1000000') }),
        ['APPROVAL_POLICY_MISMATCH'],
      ),
      notes: 'The approval names the digest of the same policy with approvalAbove "1000000".',
    }),
  },
  {
    id: 'core-021',
    title: '3.00 USDC to vendor B with an approval whose signature was altered',
    category: 'approval',
    build: async (w) => {
      const approval = await approvalFor(w, transfer300(w));
      const signature = new Uint8Array(getBase58Encoder().encode(approval.signature));
      signature[0] = (signature[0] ?? 0) ^ 0x01;
      return approvalVector(
        w,
        transfer300(w),
        { ...approval, signature: getBase58Decoder().decode(signature) },
        ['APPROVAL_SIGNATURE_INVALID'],
      );
    },
  },
  {
    id: 'core-022',
    title: '3.00 USDC to vendor B with an approval valid for 600 seconds (the policy allows 90)',
    category: 'approval',
    build: async (w) =>
      approvalVector(
        w,
        transfer300(w),
        await approvalFor(w, transfer300(w), { lifetimeSeconds: 600 }),
        ['APPROVAL_TTL_EXCEEDED'],
      ),
  },

  // ---- more format and lookup-table cases
  {
    id: 'core-023',
    title: 'Empty message',
    category: 'malformed',
    build: (w) => notDeserializable(malformed(w, 'none', new Uint8Array()), 'There is no message.'),
  },
  {
    id: 'core-024',
    title: 'v0 message that loads index 5 from a lookup table with 2 entries',
    category: 'lookup-table',
    build: (w) => {
      const compiled = v0LookupTransfer(w);
      const lookups = (compiled.addressTableLookups ?? []).map((l) => ({
        ...l,
        readonlyIndexes: [5],
      }));
      return {
        messageVersion: 'v0',
        message: encode({ ...compiled, addressTableLookups: lookups }),
        accounts: withLookupTable(w),
        policy: 'payouts',
        ...deny('LOOKUP_TABLE_UNRESOLVED'),
        runtimeVerdict: 'runtime_rejects',
        runtimeCheckedBy: 'litesvm',
      };
    },
  },
  {
    id: 'core-069',
    title: 'v1 transfer under a policy that allows only legacy and v0',
    category: 'version',
    build: (w) => ({
      messageVersion: 'v1',
      message: encode(compileV1(w.treasury.address, [pay(w, w.vendorAAta, 500_000n)], V1_CONFIG)),
      accounts: baseAccounts(w),
      policy: 'payouts-no-v1',
      ...deny('VERSION_NOT_ALLOWED'),
      runtimeVerdict: 'runtime_accepts',
      runtimeCheckedBy: 'litesvm',
    }),
  },

  // ---- fee payer and signers
  {
    id: 'core-025',
    title: 'The outsider pays the fee for an otherwise allowed transfer',
    category: 'signers',
    build: (w) => ({
      ...legacyVector(w, [], deny('FEE_PAYER_NOT_ALLOWED', 'UNEXPECTED_SIGNER'), 'runtime_accepts'),
      message: legacy(w, [...budget(), pay(w, w.vendorAAta, 1_000_000n)], w.outsider.address),
    }),
  },
  {
    id: 'core-026',
    title: 'An extra required signer, attached to the compute-unit-limit instruction',
    category: 'signers',
    build: (w) => {
      const [limit, price] = budget() as [Instruction, Instruction];
      const withSigner = {
        ...limit,
        accounts: [{ address: w.outsider.address, role: AccountRole.READONLY_SIGNER }],
      };
      return legacyVector(
        w,
        [withSigner, price, pay(w, w.vendorAAta, 1_000_000n)],
        deny('UNEXPECTED_SIGNER'),
        'runtime_accepts',
      );
    },
  },
  {
    id: 'core-027',
    title: 'A sponsored message the policy signer does not sign',
    category: 'signers',
    build: (w) => ({
      ...legacyVector(w, [], deny('SIGNER_NOT_REQUIRED'), 'runtime_accepts'),
      message: legacy(
        w,
        [
          ...budget(),
          { programAddress: SPL_MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('ping') },
        ],
        w.sponsor.address,
      ),
      policy: 'payouts-sponsored',
    }),
  },

  // ---- lifetime
  {
    id: 'core-028',
    title: '1.00 USDC to vendor A using a durable nonce',
    category: 'lifetime',
    build: (w) => ({
      ...legacyVector(w, [], deny('DURABLE_NONCE_NOT_ALLOWED'), 'runtime_accepts'),
      message: encode(
        compileLegacyWithNonce(
          w.treasury.address,
          {
            nonceAccountAddress: w.nonceAccount,
            nonceAuthority: w.treasury,
            value: FIXED_BLOCKHASH,
          },
          [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        ),
      ),
      accounts: [
        ...baseAccounts(w),
        [w.nonceAccount, nonceAccount(w.treasury.address, FIXED_BLOCKHASH)],
      ],
    }),
  },
  {
    id: 'core-029',
    title: 'A v1 instruction to a placeholder for an offline-signer program',
    category: 'lifetime',
    build: (w) => ({
      messageVersion: 'v1',
      message: encode(
        compileV1(
          w.treasury.address,
          [
            {
              programAddress: w.placeholderProgram,
              accounts: [{ address: w.treasury.address, role: AccountRole.READONLY_SIGNER }],
              data: new Uint8Array([0]),
            },
          ],
          V1_CONFIG,
        ),
      ),
      accounts: baseAccounts(w),
      policy: 'payouts',
      ...deny('PROGRAM_NOT_ALLOWED'),
      runtimeVerdict: 'runtime_rejects',
      runtimeCheckedBy: 'litesvm',
      notes:
        'The program address is a placeholder derived from a fixed seed, not a real program. It stands for the ' +
        'offline-signer programs meant to replace durable nonces: any program the policy does not know is denied.',
    }),
  },

  // ---- instruction allow-list
  {
    id: 'core-030',
    title: 'Batch with 0.50 USDC to vendor A plus an Approve that makes the outsider a delegate',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getBatchInstruction([
            pay(w, w.vendorAAta, 500_000n),
            getApproveInstruction({
              source: w.treasuryAta,
              delegate: w.outsider.address,
              owner: w.treasury,
              amount: 10_000_000n,
            }),
          ]),
        ],
        deny('TOKEN_INSTRUCTION_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-031',
    title: 'Batch under a policy that denies batch',
    category: 'instructions',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), batchOf(w)],
        deny('TOKEN_BATCH_NOT_ALLOWED'),
        'runtime_accepts',
      ),
      policy: 'payouts-no-batch',
    }),
  },
  {
    id: 'core-032',
    title: 'Unchecked SPL Token Transfer of 1.00 USDC to vendor A',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getTransferInstruction({
            source: w.treasuryAta,
            destination: w.vendorAAta,
            authority: w.treasury,
            amount: 1_000_000n,
          }),
        ],
        deny('TOKEN_INSTRUCTION_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-033',
    title: "SetAuthority that hands the treasury's token account to the outsider",
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getSetAuthorityInstruction({
            owned: w.treasuryAta,
            owner: w.treasury,
            authorityType: AuthorityType.AccountOwner,
            newAuthority: w.outsider.address,
          }),
        ],
        deny('TOKEN_INSTRUCTION_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-034',
    title: 'Token-2022 TransferChecked that mirrors the allowed SPL Token transfer',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getTransferChecked2022({
            source: w.treasuryAta,
            mint: w.mint,
            destination: w.vendorAAta,
            authority: w.treasury,
            amount: 1_000_000n,
            decimals: 6,
          }),
        ],
        deny('TOKEN_PROGRAM_NOT_ALLOWED'),
        'runtime_rejects',
      ),
  },
  {
    id: 'core-035',
    title: 'RequestHeapFrame next to an allowed transfer',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getRequestHeapFrameInstruction({ bytes: 64 * 1024 }),
          pay(w, w.vendorAAta, 1_000_000n),
        ],
        deny('COMPUTE_BUDGET_INSTRUCTION_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-036',
    title: 'Two SetComputeUnitLimit instructions',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getSetComputeUnitLimitInstruction({ units: 40_000 }),
          pay(w, w.vendorAAta, 1_000_000n),
        ],
        deny('COMPUTE_BUDGET_INSTRUCTION_NOT_ALLOWED'),
        'runtime_rejects',
      ),
  },
  {
    id: 'core-037',
    title:
      'v1 transfer with a 0.005 SOL priority fee in transactionConfig and a no-op SetComputeUnitPrice of 1',
    category: 'fees',
    build: (w) => ({
      messageVersion: 'v1',
      message: encode(
        compileV1(
          w.treasury.address,
          [
            getSetComputeUnitPriceInstruction({ microLamports: 1n }),
            pay(w, w.vendorAAta, 500_000n),
          ],
          { ...V1_CONFIG, priorityFeeLamports: 5_000_000n },
        ),
      ),
      accounts: baseAccounts(w),
      policy: 'payouts',
      ...deny('COMPUTE_BUDGET_INSTRUCTION_IN_V1', 'FEE_CAP_EXCEEDED'),
      runtimeVerdict: 'runtime_accepts',
      runtimeCheckedBy: 'litesvm',
    }),
  },
  {
    id: 'core-038',
    title: 'Memo of 65 bytes (the policy allows 64)',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n), memo(w, 'x'.repeat(65))],
        deny('MEMO_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-039',
    title: 'Allowed transfer with a 15-byte memo signed by the treasury',
    category: 'allow',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n), memo(w, 'invoice 2026-17')],
        allow,
        'runtime_accepts',
      ),
  },
  {
    id: 'core-040',
    title: 'System Program transfer of 0.01 SOL to vendor A',
    category: 'instructions',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          getTransferSolInstruction({
            source: w.treasury,
            destination: w.vendorA,
            amount: 10_000_000n,
          }),
        ],
        deny('SYSTEM_INSTRUCTION_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-041',
    title:
      'Memo sent to the newer memo program that @solana-program/memo 0.16 calls MEMO_PROGRAM_ADDRESS',
    category: 'instructions',
    build: (w) => ({
      ...legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAAta, 1_000_000n),
          memo(w, 'hello', NEWER_MEMO_PROGRAM_ADDRESS),
        ],
        deny('PROGRAM_NOT_ALLOWED'),
        'runtime_accepts',
      ),
      runtimeCheckedBy: 'not_checked',
      notes:
        'v0.1.0 treats only the SPL Memo program used by the x402 exact scheme as Memo (docs/DECISIONS.md D3). ' +
        'LiteSVM does not load the newer program, so the runtime verdict is not checked here.',
    }),
  },

  // ---- transfer checks
  {
    id: 'core-042',
    title: 'The outsider moves its own USDC to vendor A',
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAAta, 1_000_000n, { source: w.outsiderAta, authority: w.outsider }),
        ],
        deny(
          'AUTHORITY_NOT_POLICY_SIGNER',
          'SOURCE_NOT_ALLOWED',
          'SOURCE_ACCOUNT_INVALID',
          'UNEXPECTED_SIGNER',
        ),
        'runtime_accepts',
      ),
      accounts: withAccount(
        baseAccounts(w),
        w.outsiderAta,
        tokenAccount(w.mint, w.outsider.address, 5_000_000n),
      ),
    }),
  },
  {
    id: 'core-043',
    title: 'TransferChecked that lists a multisig co-signer after the authority',
    category: 'transfer',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n, { multiSigners: [w.outsider] })],
        deny('MULTISIG_AUTHORITY_NOT_SUPPORTED', 'UNEXPECTED_SIGNER'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-044',
    title: '1.00 of a token the policy does not list, to vendor A',
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAOtherAta, 1_000_000n, { source: w.treasuryOtherAta, mint: w.otherMint }),
        ],
        deny('MINT_NOT_ALLOWED', 'SOURCE_NOT_ALLOWED'),
        'runtime_accepts',
      ),
      accounts: [
        ...baseAccounts(w),
        [w.otherMint, mintAccount(w)],
        [w.treasuryOtherAta, tokenAccount(w.otherMint, w.treasury.address, 5_000_000n)],
        [w.vendorAOtherAta, tokenAccount(w.otherMint, w.vendorA, 0n)],
      ],
    }),
  },
  {
    id: 'core-045',
    title: 'The USDC mint account is owned by Token-2022 in the snapshot',
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('MINT_ACCOUNT_INVALID'),
        'runtime_accepts',
      ),
      accounts: withAccount(baseAccounts(w), w.mint, mintAccount(w, 6, TOKEN_2022_PROGRAM_ADDRESS)),
      notes:
        "Stricter than the runtime: the token program matches the mint by address (it must equal the source account's " +
        'mint) and reads its decimals, but does not check who owns the mint account. review() also requires the SPL ' +
        'Token program to own it, which catches an RPC that reports inconsistent state.',
    }),
  },
  {
    id: 'core-046',
    title: 'TransferChecked with 9 decimals for a 6-decimal mint',
    category: 'transfer',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n, { decimals: 9 })],
        deny('DECIMALS_MISMATCH'),
        'runtime_rejects',
      ),
  },
  {
    id: 'core-047',
    title: "Transfer out of vendor A's account, signed by the treasury",
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorBAta, 1_000_000n, { source: w.vendorAAta })],
        deny('SOURCE_NOT_ALLOWED', 'SOURCE_ACCOUNT_INVALID'),
        'runtime_rejects',
      ),
      accounts: withAccount(
        baseAccounts(w),
        w.vendorAAta,
        tokenAccount(w.mint, w.vendorA, 5_000_000n),
      ),
    }),
  },
  {
    id: 'core-048',
    title: 'Transfer from a frozen treasury account',
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('ACCOUNT_FROZEN'),
        'runtime_rejects',
      ),
      accounts: withAccount(
        baseAccounts(w),
        w.treasuryAta,
        tokenAccount(w.mint, w.treasury.address, 50_000_000n, AccountState.Frozen),
      ),
    }),
  },
  {
    id: 'core-049',
    title: "Vendor A's token account does not exist",
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('DESTINATION_ACCOUNT_MISSING'),
        'runtime_rejects',
      ),
      accounts: withAccount(baseAccounts(w), w.vendorAAta, null),
    }),
  },
  {
    id: 'core-050',
    title: "Vendor A's token account address holds a System Program account",
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('DESTINATION_ACCOUNT_INVALID'),
        'runtime_rejects',
      ),
      accounts: withAccount(baseAccounts(w), w.vendorAAta, {
        owner: SYSTEM_PROGRAM_ADDRESS,
        lamports: 1_000_000n,
        data: new Uint8Array(),
        executable: false,
      }),
    }),
  },
  {
    id: 'core-051',
    title: "Vendor A's account at the USDC address holds another mint",
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('DESTINATION_MINT_MISMATCH'),
        'runtime_rejects',
      ),
      accounts: withAccount(
        baseAccounts(w),
        w.vendorAAta,
        tokenAccount(w.otherMint, w.vendorA, 0n),
      ),
    }),
  },
  {
    id: 'core-052',
    title: "1.00 USDC into the outsider's USDC account that is not an associated token account",
    category: 'transfer',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.outsiderPlainAccount, 1_000_000n)],
        deny('RECIPIENT_NOT_ALLOWED', 'DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT'),
        'runtime_accepts',
      ),
      accounts: [
        ...baseAccounts(w),
        [w.outsiderPlainAccount, tokenAccount(w.mint, w.outsider.address, 0n)],
      ],
    }),
  },
  {
    id: 'core-053',
    title: "1.00 USDC into the outsider's associated token account",
    category: 'transfer',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.outsiderAta, 1_000_000n)],
        deny('RECIPIENT_NOT_ALLOWED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-054',
    title: 'TransferChecked of zero',
    category: 'transfer',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 0n)],
        deny('ZERO_AMOUNT'),
        'runtime_accepts',
      ),
  },

  // ---- amounts
  {
    id: 'core-055',
    title: 'Exactly the approval threshold: 2.00 USDC',
    category: 'amounts',
    build: (w) =>
      legacyVector(w, [...budget(), pay(w, w.vendorAAta, 2_000_000n)], allow, 'runtime_accepts'),
  },
  {
    id: 'core-056',
    title: 'One base unit above the approval threshold: 2.000001 USDC',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 2_000_001n)],
        needsApproval,
        'runtime_accepts',
        {
          approvalReasons: ['APPROVAL_REQUIRED'],
        },
      ),
  },
  {
    id: 'core-057',
    title: 'One base unit below the cap: 4.999999 USDC',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 4_999_999n)],
        needsApproval,
        'runtime_accepts',
        {
          approvalReasons: ['APPROVAL_REQUIRED'],
        },
      ),
  },
  {
    id: 'core-058',
    title: 'Exactly the cap: 5.00 USDC',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 5_000_000n)],
        needsApproval,
        'runtime_accepts',
        {
          approvalReasons: ['APPROVAL_REQUIRED'],
        },
      ),
  },
  {
    id: 'core-059',
    title: 'One base unit above the cap: 5.000001 USDC',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 5_000_001n)],
        deny('PER_TRANSACTION_LIMIT_EXCEEDED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-060',
    title: 'Three transfers of 2.00 USDC in one transaction (cap 5.00)',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAAta, 2_000_000n),
          pay(w, w.vendorBAta, 2_000_000n),
          pay(w, w.vendorAAta, 2_000_000n),
        ],
        deny('PER_TRANSACTION_LIMIT_EXCEEDED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-061',
    title: 'Two transfers of u64::MAX whose total overflows a u64',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAAta, 0xffff_ffff_ffff_ffffn),
          pay(w, w.vendorBAta, 0xffff_ffff_ffff_ffffn),
        ],
        deny('PER_TRANSACTION_LIMIT_EXCEEDED'),
        'runtime_rejects',
      ),
  },
  {
    id: 'core-062',
    title: '3.00 USDC at top level plus 1.50 and 1.50 inside a batch (total 6.00, cap 5.00)',
    category: 'amounts',
    build: (w) =>
      legacyVector(
        w,
        [
          ...budget(),
          pay(w, w.vendorAAta, 3_000_000n),
          getBatchInstruction([pay(w, w.vendorAAta, 1_500_000n), pay(w, w.vendorBAta, 1_500_000n)]),
        ],
        deny('PER_TRANSACTION_LIMIT_EXCEEDED'),
        'runtime_accepts',
      ),
  },

  // ---- fees
  {
    id: 'core-063',
    title: 'A compute-unit price with no compute-unit limit',
    category: 'fees',
    build: (w) =>
      legacyVector(
        w,
        [
          getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
          pay(w, w.vendorAAta, 1_000_000n),
        ],
        deny('COMPUTE_UNIT_LIMIT_MISSING'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-064',
    title: 'Compute-unit limit of 300,000 (the policy allows 200,000)',
    category: 'fees',
    build: (w) =>
      legacyVector(
        w,
        [...budget(300_000), pay(w, w.vendorAAta, 1_000_000n)],
        deny('COMPUTE_UNIT_LIMIT_EXCEEDED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-065',
    title: 'Priority fee of 60,000 lamports: 200,000 units at 300,000 micro-lamports (cap 50,000)',
    category: 'fees',
    build: (w) =>
      legacyVector(
        w,
        [...budget(200_000, 300_000n), pay(w, w.vendorAAta, 1_000_000n)],
        deny('FEE_CAP_EXCEEDED'),
        'runtime_accepts',
      ),
  },
  {
    id: 'core-066',
    title: 'Priority fee exactly at the cap: 200,000 units at 250,000 micro-lamports',
    category: 'fees',
    build: (w) =>
      legacyVector(
        w,
        [...budget(200_000, 250_000n), pay(w, w.vendorAAta, 1_000_000n)],
        allow,
        'runtime_accepts',
      ),
  },
  {
    id: 'core-067',
    title: 'v1 transfer whose transactionConfig sets no compute-unit limit',
    category: 'fees',
    build: (w) => ({
      messageVersion: 'v1',
      message: encode(
        compileV1(w.treasury.address, [pay(w, w.vendorAAta, 500_000n)], {
          loadedAccountsDataSizeLimit: V1_CONFIG.loadedAccountsDataSizeLimit,
          priorityFeeLamports: V1_CONFIG.priorityFeeLamports,
        }),
      ),
      accounts: baseAccounts(w),
      policy: 'payouts',
      ...deny('COMPUTE_UNIT_LIMIT_MISSING'),
      runtimeVerdict: 'runtime_rejects',
      runtimeCheckedBy: 'litesvm',
      notes:
        'A v1 message without a compute-unit limit is budgeted zero units, so it cannot execute.',
    }),
  },

  // ---- missing state
  {
    id: 'core-068',
    title: "Vendor A's token account was never fetched into the snapshot",
    category: 'state',
    build: (w) => ({
      ...legacyVector(
        w,
        [...budget(), pay(w, w.vendorAAta, 1_000_000n)],
        deny('ACCOUNT_STATE_MISSING'),
        'runtime_rejects',
      ),
      accounts: withoutAccount(baseAccounts(w), w.vendorAAta),
      runtimeCheckedBy: 'litesvm',
      notes:
        "The snapshot leaves vendor A's token account out on purpose, so against it the runtime rejects the transfer. With the account in place the transfer would execute; review() never assumes state it was not given.",
    }),
  },
];

/** The policy JSON a vector is evaluated under, by name. */
export { policyJson };
