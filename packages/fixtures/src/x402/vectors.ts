// x402 vector definitions: how each payment or quote is built and what the guard and the verifier
// answer. What the spec says about each vector is in labels.ts.
import type { Address, Instruction } from '@solana/kit';
import {
  getApproveCheckedInstruction,
  getApproveInstruction,
  getBatchInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import { getTransferCheckedInstruction as transfer2022 } from '@solana-program/token-2022';
import { getDefaultAsset } from '@x402/svm';
import type { PaymentRequirements } from '@x402/core/types';

import {
  type ReasonCode,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
} from '@nexbridge/solana-signing-firewall';

import { FIXED_BLOCKHASH } from '../messages.js';
import { lookupTableAccount, nonceAccount, tokenAccount } from '../world.js';
import {
  SDK_V1_CONFIG,
  budgetInstructions,
  createNoopSigner,
  handBuilt,
  memoInstruction,
  nonceFor,
  sdkBuilt,
  sdkLayout,
  signerMeta,
  transferInstruction,
} from './payments.js';
import {
  DEVNET,
  MAINNET,
  type X402World,
  delegatedTokenAccount,
  mint,
  quote,
  x402Accounts,
} from './world.js';

type Codes = ReasonCode[];

export type X402Built = {
  requirements: unknown;
  transaction?: string;
  accounts: [Address, SnapshotAccount | null][];
  ledger?: {
    time: string;
    mint: Address;
    amount: string;
    payee: Address;
    requirementsDigest: string;
    messageDigest: string;
  }[];
  client?: { outcome: 'allow' | 'deny'; reasons: Codes };
  facilitator?: { outcome: 'valid' | 'invalid'; reasons: Codes };
};

export type X402Definition = {
  id: string;
  title: string;
  build: (w: X402World) => Promise<X402Built>;
};

export const X402_NOW = '2026-11-20T00:00:00.000Z';
const NOW_MS = Date.parse(X402_NOW);

const allow = { outcome: 'allow' as const, reasons: [] as Codes };
const valid = { outcome: 'valid' as const, reasons: [] as Codes };
const deny = (...reasons: Codes) => ({ outcome: 'deny' as const, reasons });
const invalid = (...reasons: Codes) => ({ outcome: 'invalid' as const, reasons });

/** A payment both sides see: hand-built transaction, default quote, default accounts. */
async function payment(
  w: X402World,
  spec: Parameters<typeof handBuilt>[1],
  expectation: Pick<X402Built, 'client' | 'facilitator'>,
  requirements: unknown = quote(w),
  accounts = x402Accounts(w),
): Promise<X402Built> {
  return { requirements, transaction: await handBuilt(w, spec), accounts, ...expectation };
}

/** A quote the guard checks before any transaction exists. */
function quoteOnly(
  w: X402World,
  requirements: unknown,
  reasons: Codes,
  extra: Partial<X402Built> = {},
): Promise<X402Built> {
  return Promise.resolve({
    requirements,
    accounts: x402Accounts(w),
    client: deny(...reasons),
    ...extra,
  });
}

const sdkQuote = (w: X402World, versions: number[], extra: Record<string, unknown> = {}) =>
  quote(w, {}, { transactionVersions: versions, recentBlockhash: FIXED_BLOCKHASH, ...extra });

function reservations(w: X402World, count: number, amount: string, ageSeconds: number) {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(NOW_MS - ageSeconds * 1000 - i).toISOString(),
    mint: w.mint,
    amount,
    payee: w.shop.address,
    requirementsDigest: '0'.repeat(64),
    messageDigest: i.toString(16).padStart(64, '0'),
  }));
}

export const X402_VECTORS: X402Definition[] = [
  // ---- what the SDK builds
  {
    id: 'x402-001',
    title: 'Payment built by @x402/svm 2.31.0, version 0, at the per-payment cap',
    build: async (w) => {
      const requirements = sdkQuote(w, [0]);
      return {
        requirements,
        transaction: await sdkBuilt(
          w,
          requirements as PaymentRequirements,
          new Map(x402Accounts(w) as [Address, SnapshotAccount][]),
          'x402-001',
        ),
        accounts: x402Accounts(w),
        client: allow,
        facilitator: valid,
      };
    },
  },
  {
    id: 'x402-002',
    title:
      'Payment built by @x402/svm 2.31.0, version 1 (the SDK default when [0, 1] is advertised)',
    build: async (w) => {
      const requirements = sdkQuote(w, [0, 1]);
      return {
        requirements,
        transaction: await sdkBuilt(
          w,
          requirements as PaymentRequirements,
          new Map(x402Accounts(w) as [Address, SnapshotAccount][]),
          'x402-002',
        ),
        accounts: x402Accounts(w),
        client: allow,
        facilitator: valid,
      };
    },
  },
  {
    id: 'x402-003',
    title: 'Payment built by @x402/svm 2.31.0, version 1, with a seller memo',
    build: async (w) => {
      const requirements = sdkQuote(w, [0, 1], { memo: 'invoice-0001' });
      return {
        requirements,
        transaction: await sdkBuilt(
          w,
          requirements as PaymentRequirements,
          new Map(x402Accounts(w) as [Address, SnapshotAccount][]),
          'x402-003',
        ),
        accounts: x402Accounts(w),
        client: allow,
        facilitator: valid,
      };
    },
  },

  // ---- what moves, and to whom
  {
    id: 'x402-004',
    title: 'ApproveChecked in place of TransferChecked (same data layout, one byte apart)',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            getApproveCheckedInstruction({
              source: w.agentAta,
              mint: w.mint,
              delegate: w.shop.address,
              owner: w.agent,
              amount: 20_000n,
              decimals: 6,
            }),
            memoInstruction(nonceFor('x402-004')),
          ],
        },
        {
          client: deny('TOKEN_INSTRUCTION_NOT_ALLOWED', 'X402_NOT_TRANSFER_CHECKED'),
          facilitator: invalid('X402_NOT_TRANSFER_CHECKED'),
        },
      ),
  },
  {
    id: 'x402-005',
    title: 'A transaction that moves no tokens',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [...budgetInstructions(), memoInstruction(nonceFor('x402-005'))],
        },
        {
          client: deny('SIGNER_NOT_REQUIRED', 'X402_LAYOUT_INVALID', 'X402_NOT_TRANSFER_CHECKED'),
          facilitator: invalid('X402_LAYOUT_INVALID', 'X402_NOT_TRANSFER_CHECKED'),
        },
      ),
  },
  {
    id: 'x402-006',
    title: "Pays the associated token account of another owner (the outsider's)",
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(
            w,
            0,
            'x402-006',
            transferInstruction(w, { destination: w.outsiderAta }),
          ),
        },
        {
          client: deny('RECIPIENT_NOT_ALLOWED', 'X402_DESTINATION_NOT_PAYTO_ATA'),
          facilitator: invalid('X402_DESTINATION_NOT_PAYTO_ATA'),
        },
      ),
  },
  {
    id: 'x402-007',
    title: 'Pays one base unit less than quoted',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(w, 0, 'x402-007', transferInstruction(w, { amount: 19_999n })),
        },
        {
          client: deny('X402_AMOUNT_MISMATCH'),
          facilitator: invalid('X402_AMOUNT_MISMATCH'),
        },
      ),
  },
  {
    id: 'x402-008',
    title: 'Pays one base unit more than quoted',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(w, 0, 'x402-008', transferInstruction(w, { amount: 10_001n })),
        },
        {
          client: deny('X402_AMOUNT_MISMATCH'),
          facilitator: invalid('X402_AMOUNT_MISMATCH'),
        },
        quote(w, { amount: '10000' }),
      ),
  },
  {
    id: 'x402-009',
    title: 'Token-2022 mint with the same decimals, paid with Token-2022 TransferChecked',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transfer2022({
              source: w.agentAta2022,
              mint: w.token2022Mint,
              destination: w.shopAta2022,
              authority: w.agent,
              amount: 20_000n,
              decimals: 6,
            }),
            memoInstruction(nonceFor('x402-009')),
          ],
        },
        {
          client: deny(
            'X402_ASSET_NOT_ALLOWED',
            'TOKEN_PROGRAM_NOT_ALLOWED',
            'X402_NOT_TRANSFER_CHECKED',
          ),
          facilitator: invalid(
            'X402_ASSET_NOT_ALLOWED',
            'TOKEN_PROGRAM_NOT_ALLOWED',
            'X402_NOT_TRANSFER_CHECKED',
          ),
        },
        quote(w, { asset: w.token2022Mint }),
      ),
  },
  {
    id: 'x402-010',
    title: 'A hidden Approve, making the outsider a delegate, after the transfer',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            getApproveInstruction({
              source: w.agentAta,
              delegate: w.outsider.address,
              owner: w.agent,
              amount: 1_000_000n,
            }),
            memoInstruction(nonceFor('x402-010')),
          ],
        },
        {
          client: deny('TOKEN_INSTRUCTION_NOT_ALLOWED', 'X402_LAYOUT_INVALID'),
          facilitator: invalid('X402_LAYOUT_INVALID'),
        },
      ),
  },
  {
    id: 'x402-011',
    title: 'The transfer wrapped in a P-Token batch',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            getBatchInstruction([transferInstruction(w)]),
            memoInstruction(nonceFor('x402-011')),
          ],
        },
        {
          client: deny('TOKEN_BATCH_NOT_ALLOWED', 'X402_NOT_TRANSFER_CHECKED'),
          facilitator: invalid('X402_NOT_TRANSFER_CHECKED'),
        },
      ),
  },

  {
    id: 'x402-045',
    title: 'Transfers another SPL token than the quoted asset, into the quoted destination',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(w, 0, 'x402-045', transferInstruction(w, { mint: w.otherMint })),
        },
        {
          client: deny(
            'MINT_NOT_ALLOWED',
            'SOURCE_ACCOUNT_INVALID',
            'DESTINATION_MINT_MISMATCH',
            'DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT',
            'X402_MINT_MISMATCH',
          ),
          facilitator: invalid('X402_MINT_MISMATCH'),
        },
        quote(w),
        [...x402Accounts(w), [w.otherMint, mint(TOKEN_PROGRAM_ADDRESS)]],
      ),
  },

  // ---- the fee payer
  {
    id: 'x402-012',
    title: 'The fee payer is the transfer authority and pays from its own account',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(
            w,
            0,
            'x402-012',
            transferInstruction(w, { source: w.feePayerAta, authority: w.feePayer }),
          ),
        },
        {
          facilitator: invalid('X402_FEE_PAYER_IN_INSTRUCTION'),
        },
      ),
  },
  {
    id: 'x402-013',
    title: 'A fee payer other than the one the quote names',
    build: (w) =>
      payment(
        w,
        { version: 0, feePayer: w.outsider.address, instructions: sdkLayout(w, 0, 'x402-013') },
        {
          client: deny('FEE_PAYER_NOT_ALLOWED', 'UNEXPECTED_SIGNER', 'X402_FEE_PAYER_MISMATCH'),
          facilitator: invalid('X402_FEE_PAYER_MISMATCH'),
        },
      ),
  },

  // ---- the source account, and every fee payer of the verifier config (docs/DECISIONS.md D54)
  {
    id: 'x402-046',
    title: "Pays from the payee's own token account into itself, the buyer being its delegate",
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(w, 0, 'x402-046', transferInstruction(w, { source: w.shopAta })),
        },
        { facilitator: invalid('X402_SOURCE_NOT_PAYER_ATA') },
        quote(w),
        [
          ...x402Accounts(w).filter(([a]) => a !== w.shopAta),
          [
            w.shopAta,
            delegatedTokenAccount(w.mint, w.shop.address, 20_000n, w.agent.address, 20_000n),
          ],
        ],
      ),
  },
  {
    id: 'x402-047',
    title: "Pays from the fee payer's token account, the buyer being its delegate",
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(
            w,
            0,
            'x402-047',
            transferInstruction(w, { source: w.feePayerAta }),
          ),
        },
        { facilitator: invalid('X402_SOURCE_NOT_PAYER_ATA') },
        quote(w),
        [
          ...x402Accounts(w).filter(([a]) => a !== w.feePayerAta),
          [
            w.feePayerAta,
            delegatedTokenAccount(w.mint, w.feePayer.address, 100_000n, w.agent.address, 20_000n),
          ],
        ],
      ),
  },
  {
    id: 'x402-048',
    title: 'Pays from a token account of the buyer that is not its associated token account',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(
            w,
            0,
            'x402-048',
            transferInstruction(w, { source: w.agentOtherAccount }),
          ),
        },
        {
          client: deny('SOURCE_NOT_ALLOWED', 'X402_SOURCE_NOT_PAYER_ATA'),
          facilitator: invalid('X402_SOURCE_NOT_PAYER_ATA'),
        },
        quote(w),
        [
          ...x402Accounts(w),
          [w.agentOtherAccount, tokenAccount(w.mint, w.agent.address, 100_000n)],
        ],
      ),
  },
  {
    id: 'x402-049',
    title: 'The transfer authority is another fee payer of the verifier config',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(
            w,
            0,
            'x402-049',
            transferInstruction(w, { source: w.secondFeePayerAta, authority: w.secondFeePayer }),
          ),
        },
        { facilitator: invalid('X402_FEE_PAYER_IN_INSTRUCTION') },
        quote(w),
        [
          ...x402Accounts(w),
          [w.secondFeePayerAta, tokenAccount(w.mint, w.secondFeePayer.address, 100_000n)],
        ],
      ),
  },

  // ---- lifetime, budget and limits
  {
    id: 'x402-014',
    title: 'A durable-nonce payment',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          nonce: { account: w.nonceAccount, authority: w.agent.address, value: FIXED_BLOCKHASH },
          instructions: sdkLayout(w, 0, 'x402-014'),
        },
        {
          client: deny('DURABLE_NONCE_NOT_ALLOWED', 'X402_LAYOUT_INVALID'),
          facilitator: invalid('DURABLE_NONCE_NOT_ALLOWED', 'X402_LAYOUT_INVALID'),
        },
        quote(w),
        [...x402Accounts(w), [w.nonceAccount, nonceAccount(w.agent.address, FIXED_BLOCKHASH)]],
      ),
  },
  {
    id: 'x402-015',
    title: 'Compute-unit price of 5,000,001 micro-lamports (the cap is 5,000,000)',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(5_000_001n),
            transferInstruction(w),
            memoInstruction(nonceFor('x402-015')),
          ],
        },
        {
          client: deny('FEE_CAP_EXCEEDED', 'X402_COMPUTE_UNIT_PRICE_EXCEEDED'),
          facilitator: invalid('FEE_CAP_EXCEEDED', 'X402_COMPUTE_UNIT_PRICE_EXCEEDED'),
        },
      ),
  },
  {
    id: 'x402-016',
    title:
      'Version 1 with a 0.005 SOL priority fee in transactionConfig and a no-op SetComputeUnitPrice of 1',
    build: (w) =>
      payment(
        w,
        {
          version: 1,
          config: { ...SDK_V1_CONFIG, priorityFeeLamports: 5_000_000n },
          instructions: [
            budgetInstructions()[1] as Instruction,
            transferInstruction(w),
            memoInstruction(nonceFor('x402-016')),
          ],
        },
        {
          client: deny(
            'COMPUTE_BUDGET_INSTRUCTION_IN_V1',
            'FEE_CAP_EXCEEDED',
            'X402_LAYOUT_INVALID',
            'X402_COMPUTE_UNIT_PRICE_EXCEEDED',
          ),
          facilitator: invalid(
            'COMPUTE_BUDGET_INSTRUCTION_IN_V1',
            'FEE_CAP_EXCEEDED',
            'X402_LAYOUT_INVALID',
            'X402_COMPUTE_UNIT_PRICE_EXCEEDED',
          ),
        },
      ),
  },
  {
    id: 'x402-017',
    title:
      "Creates the shop's token account, funded by the fee payer, though nothing authorizes it",
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            createAta(w),
            transferInstruction(w),
            memoInstruction(nonceFor('x402-017')),
          ],
        },
        {
          client: deny(
            'PROGRAM_NOT_ALLOWED',
            'X402_LAYOUT_INVALID',
            'X402_CREATE_ATA_NOT_ALLOWED',
            'X402_FEE_PAYER_IN_INSTRUCTION',
          ),
          facilitator: invalid(
            'X402_LAYOUT_INVALID',
            'X402_CREATE_ATA_NOT_ALLOWED',
            'X402_FEE_PAYER_IN_INSTRUCTION',
          ),
        },
      ),
  },
  {
    id: 'x402-018',
    title: 'Mint and destination loaded from an address lookup table',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: sdkLayout(w, 0, 'x402-018'),
          lookupTables: { [w.lookupTable]: [w.mint, w.shopAta] },
        },
        {
          client: deny('X402_LOOKUP_TABLE_NOT_ALLOWED'),
          facilitator: invalid('X402_LOOKUP_TABLE_NOT_ALLOWED'),
        },
        quote(w),
        [...x402Accounts(w), [w.lookupTable, lookupTableAccount([w.mint, w.shopAta])]],
      ),
  },
  {
    id: 'x402-019',
    title: "The buyer's signature does not verify",
    build: async (w) => {
      const wire = Buffer.from(
        await handBuilt(w, { version: 0, instructions: sdkLayout(w, 0, 'x402-019') }),
        'base64',
      );
      // v0 wire layout: signature count, fee payer signature (empty), buyer signature, message.
      wire[70] = (wire[70] ?? 0) ^ 0xff;
      return {
        requirements: quote(w),
        transaction: wire.toString('base64'),
        accounts: x402Accounts(w),
        facilitator: invalid('X402_PAYER_SIGNATURE_INVALID'),
      };
    },
  },
  {
    id: 'x402-020',
    title: "The buyer's token account does not exist",
    build: (w) =>
      payment(
        w,
        { version: 0, instructions: sdkLayout(w, 0, 'x402-020') },
        {
          client: deny('SOURCE_ACCOUNT_INVALID'),
          facilitator: invalid('X402_SOURCE_ACCOUNT_MISSING'),
        },
        quote(w),
        [...x402Accounts(w).filter(([a]) => a !== w.agentAta), [w.agentAta, null]],
      ),
  },
  {
    id: 'x402-021',
    title: 'A third required signer',
    build: (w) => {
      const [limit, price] = budgetInstructions() as [Instruction, Instruction];
      return payment(
        w,
        {
          version: 0,
          instructions: [
            { ...limit, accounts: [signerMeta(w.outsider.address)] },
            price,
            transferInstruction(w),
            memoInstruction(nonceFor('x402-021')),
          ],
        },
        {
          client: deny('UNEXPECTED_SIGNER'),
          facilitator: invalid('UNEXPECTED_SIGNER'),
        },
      );
    },
  },
  {
    id: 'x402-022',
    title: 'Requirements whose amount is not a decimal string of base units',
    build: (w) =>
      payment(
        w,
        { version: 0, instructions: sdkLayout(w, 0, 'x402-022') },
        {
          client: deny('X402_REQUIREMENTS_MALFORMED'),
          facilitator: invalid('X402_REQUIREMENTS_MALFORMED'),
        },
        quote(w, { amount: '0.02' }),
      ),
  },

  // ---- the Memo (docs/DECISIONS.md D7)
  {
    id: 'x402-023',
    title: 'No Memo',
    build: (w) =>
      payment(
        w,
        { version: 0, instructions: [...budgetInstructions(), transferInstruction(w)] },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: invalid('X402_MEMO_MISMATCH'),
        },
      ),
  },
  {
    id: 'x402-024',
    title: 'Two nonce Memos, no seller memo',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [...sdkLayout(w, 0, 'x402-024'), memoInstruction(nonceFor('x402-024b'))],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: valid,
        },
      ),
  },
  {
    id: 'x402-025',
    title: 'Memo text differs from the seller memo',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            memoInstruction('invoice-0002'),
          ],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: invalid('X402_MEMO_MISMATCH'),
        },
        quote(w, {}, { memo: 'invoice-0001' }),
      ),
  },
  {
    id: 'x402-026',
    title: 'Memo of 32 characters that are not hexadecimal',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            memoInstruction('z'.repeat(32)),
          ],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: invalid('X402_MEMO_MISMATCH'),
        },
      ),
  },
  {
    id: 'x402-027',
    title: 'Memo nonce of 32 bytes (64 lower-case hex characters)',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            memoInstruction(nonceFor('a') + nonceFor('b')),
          ],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: valid,
        },
      ),
  },
  {
    id: 'x402-028',
    title: 'Memo nonce in upper-case hexadecimal',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            memoInstruction(nonceFor('x402-028').toUpperCase()),
          ],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: valid,
        },
      ),
  },
  {
    id: 'x402-029',
    title: 'Memo before the transfer',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            memoInstruction(nonceFor('x402-029')),
            transferInstruction(w),
          ],
        },
        {
          client: deny('X402_LAYOUT_INVALID'),
          facilitator: invalid('X402_LAYOUT_INVALID'),
        },
      ),
  },
  {
    id: 'x402-030',
    title: 'Memo that lists the buyer as an account',
    build: (w) =>
      payment(
        w,
        {
          version: 0,
          instructions: [
            ...budgetInstructions(),
            transferInstruction(w),
            memoInstruction(nonceFor('x402-030'), [signerMeta(w.agent.address)]),
          ],
        },
        {
          client: deny('X402_MEMO_MISMATCH'),
          facilitator: valid,
        },
      ),
  },
  {
    id: 'x402-044',
    title: 'Version 1 whose transactionConfig sets no loaded-accounts data size',
    build: (w) =>
      payment(
        w,
        {
          version: 1,
          config: { computeUnitLimit: 20_000, priorityFeeLamports: 1n },
          instructions: sdkLayout(w, 1, 'x402-044'),
        },
        {
          client: deny('X402_LAYOUT_INVALID'),
          facilitator: invalid('X402_LAYOUT_INVALID'),
        },
      ),
  },

  // ---- quote level: before any transaction exists
  {
    id: 'x402-031',
    title: 'Quote with a split to the outsider',
    build: (w) =>
      quoteOnly(w, quote(w, {}, { splits: [{ payTo: w.outsider.address, amount: '1000' }] }), [
        'X402_SPLITS_NOT_ALLOWED',
      ]),
  },
  {
    id: 'x402-032',
    title: "Quote that marks the shop's token account for creation",
    build: (w) =>
      quoteOnly(w, quote(w, {}, { ataCreationRequired: true }), ['X402_CREATE_ATA_NOT_ALLOWED']),
  },
  {
    id: 'x402-033',
    title: 'Scheme upto',
    build: (w) => quoteOnly(w, quote(w, { scheme: 'upto' }), ['X402_SCHEME_NOT_ALLOWED']),
  },
  {
    id: 'x402-034',
    title: 'Mainnet',
    build: (w) => quoteOnly(w, quote(w, { network: MAINNET }), ['X402_NETWORK_NOT_ALLOWED']),
  },
  {
    id: 'x402-035',
    title: 'A token the policy does not list (the SDK default devnet PYUSD)',
    build: (w) =>
      quoteOnly(w, quote(w, { asset: getDefaultAsset(DEVNET, 'PYUSD').asset, amount: '10000' }), [
        'X402_ASSET_NOT_ALLOWED',
      ]),
  },
  {
    id: 'x402-036',
    title: 'Pays the outsider',
    build: (w) => quoteOnly(w, quote(w, { payTo: w.outsider.address }), ['X402_PAYTO_NOT_ALLOWED']),
  },
  {
    id: 'x402-037',
    title: 'Names the agent itself as fee payer',
    build: (w) =>
      quoteOnly(w, quote(w, {}, { feePayer: w.agent.address }), ['X402_FEE_PAYER_NOT_ALLOWED']),
  },
  {
    id: 'x402-038',
    title: 'Amount one base unit over the per-payment cap',
    build: (w) => quoteOnly(w, quote(w, { amount: '20001' }), ['X402_PER_PAYMENT_LIMIT_EXCEEDED']),
  },
  {
    id: 'x402-039',
    title: 'Zero amount',
    build: (w) => quoteOnly(w, quote(w, { amount: '0' }), ['ZERO_AMOUNT']),
  },
  {
    id: 'x402-040',
    title: 'Timeout of 300 seconds (the policy allows 120)',
    build: (w) => quoteOnly(w, quote(w, { maxTimeoutSeconds: 300 }), ['X402_TIMEOUT_OUT_OF_RANGE']),
  },
  {
    id: 'x402-041',
    title: 'Daily budget exhausted: 0.04 USDC spent today, 0.02 more against a 0.05 budget',
    build: (w) =>
      quoteOnly(w, quote(w), ['X402_BUDGET_EXCEEDED'], {
        ledger: reservations(w, 2, '20000', 3600),
      }),
  },
  {
    id: 'x402-042',
    title: 'Ten payments in the last minute (the policy allows ten per minute)',
    build: (w) =>
      quoteOnly(w, quote(w), ['X402_RATE_LIMIT_EXCEEDED'], {
        ledger: reservations(w, 10, '1', 10),
      }),
  },
  {
    id: 'x402-043',
    title: 'No fee payer in the quote',
    build: (w) => {
      const { extra, ...rest } = quote(w);
      const withoutFeePayer = Object.fromEntries(
        Object.entries(extra).filter(([key]) => key !== 'feePayer'),
      );
      return quoteOnly(w, { ...rest, extra: withoutFeePayer }, ['X402_FEE_PAYER_NOT_ALLOWED']);
    },
  },
];

function createAta(w: X402World): Instruction {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(w.feePayer.address),
    ata: w.shopAta,
    owner: w.shop.address,
    mint: w.mint,
  });
}
