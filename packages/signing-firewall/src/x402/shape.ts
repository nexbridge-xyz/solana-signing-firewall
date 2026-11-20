// The parts of an x402 `exact` payment both the guard and the verifier inspect.
import type { Address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';

import type {
  ClassifiedInstruction,
  DecodedTransactionMessage,
  Transfer,
} from '../decode/types.js';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../programs.js';
import type { Reason } from '../reasons.js';
import type { X402Requirements } from './requirements.js';

export type PaymentShape = {
  /** The SPL Token or Token-2022 instruction in the transfer position, if any. */
  readonly token: ClassifiedInstruction | undefined;
  /** The transfer, when the token instruction is an SPL Token TransferChecked. */
  readonly transfer: Transfer | undefined;
  readonly memos: readonly ClassifiedInstruction[];
  readonly computeUnitPriceMicroLamports: bigint | undefined;
  /** Why the instruction sequence is not the accepted layout; empty when it is. */
  readonly layoutProblems: readonly string[];
  readonly createsAccount: boolean;
};

const isToken = (ix: ClassifiedInstruction) =>
  ix.program === 'spl-token' || ix.program === 'token-2022';

/**
 * Splits a payment into its parts and checks the instruction order: version 0
 * `SetComputeUnitLimit, SetComputeUnitPrice, <token instruction>`, version 1
 * `<token instruction>`, each followed only by Memo instructions. This is a strict
 * subset of the spec's static layout (docs/DECISIONS.md D8).
 */
export function paymentShape(message: DecodedTransactionMessage): PaymentShape {
  const problems: string[] = [];
  const nonMemo = message.instructions.filter((ix) => ix.program !== 'memo');
  const memos = message.instructions.filter((ix) => ix.program === 'memo');
  const expected = message.version === 'v1' ? ['token'] : ['limit', 'price', 'token'];
  const actual = nonMemo.map((ix) =>
    isToken(ix)
      ? 'token'
      : ix.program === 'compute-budget' && ix.computeBudget.type === 'set-compute-unit-limit'
        ? 'limit'
        : ix.program === 'compute-budget' && ix.computeBudget.type === 'set-compute-unit-price'
          ? 'price'
          : `${ix.program} ${ix.programAddress}`,
  );
  if (actual.join(',') !== expected.join(',')) {
    problems.push(
      `instructions are [${actual.join(', ')}], expected [${expected.join(', ')}] then Memo`,
    );
  }
  const token = nonMemo.find(isToken);
  const tokenIndex = token === undefined ? -1 : message.instructions.indexOf(token);
  const memoBeforeTransfer = memos.some((m) => message.instructions.indexOf(m) < tokenIndex);
  if (memoBeforeTransfer) problems.push('a Memo comes before the token instruction');
  if (message.version === 'v1') {
    const fees = message.fees;
    if (fees.source === 'transactionConfig' && fees.loadedAccountsDataSizeLimit === undefined) {
      problems.push('transactionConfig must set loadedAccountsDataSizeLimit');
    }
  }

  const price = nonMemo.find(
    (ix) => ix.program === 'compute-budget' && ix.computeBudget.type === 'set-compute-unit-price',
  );
  return {
    token,
    transfer:
      token?.program === 'spl-token' && token.token.type === 'transfer-checked'
        ? token.token.transfer
        : undefined,
    memos,
    computeUnitPriceMicroLamports:
      price?.program === 'compute-budget' && price.computeBudget.type === 'set-compute-unit-price'
        ? price.computeBudget.microLamports
        : undefined,
    layoutProblems: problems,
    createsAccount: message.instructions.some(
      (ix) => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    ),
  };
}

/**
 * Checks shared by the guard and the verifier: the token instruction, amount, mint, source,
 * destination, fee payer, compute-unit price, account creation and lookup tables.
 *
 * `feePayers` are the fee payers the caller knows of (the policy's, or the verifier config's).
 * None of them, and not the message's own fee payer, may appear in any instruction.
 */
export async function bindingReasons(
  message: DecodedTransactionMessage,
  shape: PaymentShape,
  requirements: X402Requirements,
  limits: {
    readonly maxComputeUnitPriceMicroLamports: bigint;
    readonly feePayers: readonly Address[];
  },
): Promise<Reason[]> {
  const reasons: Reason[] = [];
  if (shape.layoutProblems.length > 0) {
    reasons.push({ code: 'X402_LAYOUT_INVALID', detail: shape.layoutProblems.join('; ') });
  }
  if (shape.transfer === undefined) {
    reasons.push({
      code: 'X402_NOT_TRANSFER_CHECKED',
      ...(shape.token === undefined
        ? { detail: 'no token instruction' }
        : { path: shape.token.path }),
    });
  } else {
    const t = shape.transfer;
    if (t.amount !== requirements.amount) {
      reasons.push({
        code: 'X402_AMOUNT_MISMATCH',
        path: t.path,
        detail: `${t.amount} != quoted ${requirements.amount}`,
      });
    }
    if (t.mint !== requirements.asset)
      reasons.push({ code: 'X402_MINT_MISMATCH', path: t.path, account: t.mint });
    const [payToAta] = await findAssociatedTokenPda({
      owner: requirements.payTo,
      mint: requirements.asset,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    if (t.destination !== payToAta) {
      reasons.push({
        code: 'X402_DESTINATION_NOT_PAYTO_ATA',
        path: t.path,
        account: t.destination,
      });
    }
    // The payer pays from its own associated token account for the asset, as the destination
    // is the payee's. This keeps out a source the payer may only be a delegate of: the payee's
    // own account (the payee would receive nothing) or a fee payer's (the spec, sections 2.1.1
    // and 2.1.3).
    const [payerAta] = await findAssociatedTokenPda({
      owner: t.authority,
      mint: requirements.asset,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    if (t.source !== payerAta) {
      reasons.push({ code: 'X402_SOURCE_NOT_PAYER_ATA', path: t.path, account: t.source });
    }
  }

  if (requirements.feePayer !== undefined && message.feePayer !== requirements.feePayer) {
    reasons.push({ code: 'X402_FEE_PAYER_MISMATCH', account: message.feePayer });
  }
  const isolated = new Set<Address>([message.feePayer, ...limits.feePayers]);
  for (const ix of message.instructions) {
    const found = [ix.programAddress, ...ix.accounts.map((a) => a.address)].filter((a) =>
      isolated.has(a),
    );
    for (const account of new Set(found)) {
      reasons.push({ code: 'X402_FEE_PAYER_IN_INSTRUCTION', path: ix.path, account });
    }
  }

  const cap = limits.maxComputeUnitPriceMicroLamports;
  if (message.fees.source === 'instructions') {
    const price = shape.computeUnitPriceMicroLamports ?? 0n;
    if (price > cap) {
      reasons.push({
        code: 'X402_COMPUTE_UNIT_PRICE_EXCEEDED',
        detail: `${price} > ${cap} micro-lamports per unit`,
      });
    }
  } else {
    // Spec section 1.5: priorityFee * 1,000,000 <= cap * computeUnitLimit, in exact integers.
    const units = BigInt(message.fees.computeUnitLimit ?? 0);
    if (message.fees.priorityFeeLamports * 1_000_000n > cap * units) {
      reasons.push({
        code: 'X402_COMPUTE_UNIT_PRICE_EXCEEDED',
        detail: `${message.fees.priorityFeeLamports} lamports over ${units} units exceeds ${cap} micro-lamports per unit`,
      });
    }
  }
  if (shape.createsAccount || requirements.ataCreationRequired)
    reasons.push({ code: 'X402_CREATE_ATA_NOT_ALLOWED' });
  if (message.lookupTableEntries.length > 0)
    reasons.push({ code: 'X402_LOOKUP_TABLE_NOT_ALLOWED' });
  return reasons;
}

/** What the guard (agent side) accepts as the Memo: what the pinned SDK builds (D7). */
export function guardMemoReasons(shape: PaymentShape, requirements: X402Requirements): Reason[] {
  if (shape.memos.length !== 1) {
    return [
      {
        code: 'X402_MEMO_MISMATCH',
        detail: `${shape.memos.length} Memo instructions; expected exactly 1`,
      },
    ];
  }
  const [memo] = shape.memos as [ClassifiedInstruction];
  const at = { path: memo.path };
  if (memo.accounts.length > 0)
    return [{ code: 'X402_MEMO_MISMATCH', ...at, detail: 'the Memo lists accounts' }];
  if (requirements.memo !== undefined) {
    const expected = new TextEncoder().encode(requirements.memo);
    const same =
      expected.length === memo.data.length && expected.every((byte, i) => byte === memo.data[i]);
    return same ? [] : [{ code: 'X402_MEMO_MISMATCH', ...at, detail: 'differs from extra.memo' }];
  }
  const text = new TextDecoder().decode(memo.data);
  return /^[0-9a-f]{32}$/.test(text)
    ? []
    : [{ code: 'X402_MEMO_MISMATCH', ...at, detail: 'not 32 lower-case hex characters' }];
}

/** What the verifier (facilitator side) requires of Memos (docs/DECISIONS.md D7, D53). */
export function verifierMemoReasons(shape: PaymentShape, requirements: X402Requirements): Reason[] {
  if (requirements.memo !== undefined) {
    if (shape.memos.length !== 1) {
      return [
        {
          code: 'X402_MEMO_MISMATCH',
          detail: `${shape.memos.length} Memo instructions; extra.memo requires exactly 1`,
        },
      ];
    }
    const [memo] = shape.memos as [ClassifiedInstruction];
    const expected = new TextEncoder().encode(requirements.memo);
    const same =
      expected.length === memo.data.length && expected.every((byte, i) => byte === memo.data[i]);
    return same
      ? []
      : [{ code: 'X402_MEMO_MISMATCH', path: memo.path, detail: 'differs from extra.memo' }];
  }
  // Clients MUST include a Memo with a random nonce of at least 16 bytes, hex-encoded.
  const nonce = shape.memos.some((m) =>
    /^[0-9a-fA-F]{32,}$/.test(new TextDecoder().decode(m.data)),
  );
  return nonce
    ? []
    : [{ code: 'X402_MEMO_MISMATCH', detail: 'no Memo carries a hex nonce of at least 16 bytes' }];
}
