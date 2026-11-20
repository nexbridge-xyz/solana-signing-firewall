import { getU32Decoder, getU64Decoder } from '@solana/kit';
import {
  ComputeBudgetInstruction,
  SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR,
  SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget';
import { ADVANCE_NONCE_ACCOUNT_DISCRIMINATOR } from '@solana-program/system';
import {
  BATCH_DISCRIMINATOR,
  TRANSFER_CHECKED_DISCRIMINATOR,
  TokenInstruction,
  identifyTokenInstruction,
} from '@solana-program/token';

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SPL_MEMO_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '../programs.js';
import type { Reason } from '../reasons.js';
import { parseTokenBatch } from './token-batch.js';
import type {
  AccountMeta,
  ClassifiedInstruction,
  ComputeBudgetView,
  DecodeResult,
  ResolvedInstruction,
  TokenBatchEntryView,
  TokenInstructionView,
} from './types.js';

/** TransferChecked data: discriminator, u64 amount, u8 decimals. */
const TRANSFER_CHECKED_DATA_LENGTH = 10;

function tokenInstructionName(data: Uint8Array): string | undefined {
  try {
    return TokenInstruction[identifyTokenInstruction({ data })];
  } catch {
    return undefined;
  }
}

function classifyTokenInstruction(
  path: string,
  accounts: readonly AccountMeta[],
  data: Uint8Array,
  insideBatch: boolean,
): TokenInstructionView | Reason {
  const discriminator = data[0];
  if (discriminator === TRANSFER_CHECKED_DISCRIMINATOR) {
    if (data.length !== TRANSFER_CHECKED_DATA_LENGTH) {
      return {
        type: 'other',
        name: 'TransferChecked',
        detail: `data is ${data.length} bytes, expected 10`,
      };
    }
    const [source, mint, destination, authority, ...multisig] = accounts;
    if (
      source === undefined ||
      mint === undefined ||
      destination === undefined ||
      authority === undefined
    ) {
      return {
        type: 'other',
        name: 'TransferChecked',
        detail: `has ${accounts.length} accounts, needs 4`,
      };
    }
    return {
      type: 'transfer-checked',
      transfer: {
        path,
        source: source.address,
        mint: mint.address,
        destination: destination.address,
        authority: authority.address,
        multisigSigners: multisig.map((account) => account.address),
        amount: getU64Decoder().decode(data, 1),
        decimals: data[9] as number,
      },
    };
  }
  if (discriminator === BATCH_DISCRIMINATOR) {
    // The program refuses a batch inside a batch; report it as a disallowed token instruction.
    if (insideBatch) return { type: 'other', name: 'Batch', detail: 'nested batch' };
    const parsed = parseTokenBatch(data, accounts.length);
    if (!parsed.ok) return { code: 'MALFORMED_MESSAGE', path, detail: `batch: ${parsed.detail}` };
    const entries: TokenBatchEntryView[] = [];
    for (const [j, entry] of parsed.entries.entries()) {
      const entryPath = `${path}.batch[${j}]`;
      const entryAccounts = accounts.slice(
        entry.accountOffset,
        entry.accountOffset + entry.accountCount,
      );
      const view = classifyTokenInstruction(entryPath, entryAccounts, entry.data, true);
      if ('code' in view) return view;
      entries.push({ path: entryPath, instruction: view });
    }
    return { type: 'batch', entries };
  }
  return {
    type: 'other',
    name: tokenInstructionName(data),
    ...(discriminator === undefined ? { detail: 'no instruction data' } : {}),
  };
}

function classifyComputeBudget(data: Uint8Array): ComputeBudgetView {
  if (data[0] === SET_COMPUTE_UNIT_LIMIT_DISCRIMINATOR && data.length === 5) {
    return { type: 'set-compute-unit-limit', units: getU32Decoder().decode(data, 1) };
  }
  if (data[0] === SET_COMPUTE_UNIT_PRICE_DISCRIMINATOR && data.length === 9) {
    return { type: 'set-compute-unit-price', microLamports: getU64Decoder().decode(data, 1) };
  }
  let name: string | undefined;
  try {
    name = ComputeBudgetInstruction[identifyComputeBudgetInstruction({ data })];
  } catch {
    name = undefined;
  }
  return { type: 'other', name, detail: `data is ${data.length} bytes` };
}

function advancesNonce(data: Uint8Array): boolean {
  return data.length >= 4 && getU32Decoder().decode(data) === ADVANCE_NONCE_ACCOUNT_DISCRIMINATOR;
}

/**
 * Stage 3: identify each instruction's program and parse the ones the policy
 * understands. Parsing only; no policy is applied here.
 */
export function classifyInstruction(ix: ResolvedInstruction): DecodeResult<ClassifiedInstruction> {
  const base = {
    path: ix.path,
    programAddress: ix.programAddress,
    accounts: ix.accounts,
    data: ix.data,
  };
  switch (ix.programAddress) {
    case TOKEN_PROGRAM_ADDRESS: {
      const token = classifyTokenInstruction(ix.path, ix.accounts, ix.data, false);
      if ('code' in token) return { ok: false, version: undefined, reasons: [token] };
      return { ok: true, value: { ...base, program: 'spl-token', token } };
    }
    case TOKEN_2022_PROGRAM_ADDRESS:
      return { ok: true, value: { ...base, program: 'token-2022' } };
    case COMPUTE_BUDGET_PROGRAM_ADDRESS:
      return {
        ok: true,
        value: {
          ...base,
          program: 'compute-budget',
          computeBudget: classifyComputeBudget(ix.data),
        },
      };
    case SPL_MEMO_PROGRAM_ADDRESS:
      return { ok: true, value: { ...base, program: 'memo' } };
    case SYSTEM_PROGRAM_ADDRESS:
      return {
        ok: true,
        value: { ...base, program: 'system', advancesNonce: advancesNonce(ix.data) },
      };
    default:
      return { ok: true, value: { ...base, program: 'other' } };
  }
}
