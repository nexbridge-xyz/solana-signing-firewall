import type { Snapshot } from '../snapshot.js';
import { classifyInstruction } from './classify.js';
import { decodeCompiledMessage } from './compiled.js';
import { resolveMessage } from './resolve.js';
import type {
  ClassifiedInstruction,
  DecodeResult,
  DecodedTransactionMessage,
  Fees,
  Transfer,
} from './types.js';

export { detectMessageVersion, decodeCompiledMessage } from './compiled.js';
export { resolveMessage } from './resolve.js';
export { classifyInstruction } from './classify.js';
export { parseTokenBatch, type TokenBatchEntry } from './token-batch.js';
export type * from './types.js';

function collectTransfers(instructions: readonly ClassifiedInstruction[]): Transfer[] {
  const transfers: Transfer[] = [];
  for (const ix of instructions) {
    if (ix.program !== 'spl-token') continue;
    if (ix.token.type === 'transfer-checked') transfers.push(ix.token.transfer);
    if (ix.token.type === 'batch') {
      for (const entry of ix.token.entries) {
        if (entry.instruction.type === 'transfer-checked')
          transfers.push(entry.instruction.transfer);
      }
    }
  }
  return transfers;
}

function collectFees(
  version: DecodedTransactionMessage['version'],
  config:
    | {
        computeUnitLimit?: number;
        loadedAccountsDataSizeLimit?: number;
        heapSize?: number;
        priorityFeeLamports?: bigint;
      }
    | undefined,
  instructions: readonly ClassifiedInstruction[],
): Fees {
  if (version === 'v1') {
    // v1 fees come only from transactionConfig; ComputeBudget instructions are no-ops there.
    return {
      source: 'transactionConfig',
      computeUnitLimit: config?.computeUnitLimit,
      loadedAccountsDataSizeLimit: config?.loadedAccountsDataSizeLimit,
      heapSize: config?.heapSize,
      priorityFeeLamports: config?.priorityFeeLamports ?? 0n,
    };
  }
  let computeUnitLimit: number | undefined;
  let computeUnitPriceMicroLamports: bigint | undefined;
  for (const ix of instructions) {
    if (ix.program !== 'compute-budget') continue;
    const view = ix.computeBudget;
    if (view.type === 'set-compute-unit-limit') computeUnitLimit ??= view.units;
    if (view.type === 'set-compute-unit-price')
      computeUnitPriceMicroLamports ??= view.microLamports;
  }
  return { source: 'instructions', computeUnitLimit, computeUnitPriceMicroLamports };
}

/**
 * Decodes message bytes against a snapshot: parse, sanitize, resolve lookup
 * tables, and classify instructions. Never throws and never touches the network.
 */
export function decodeTransactionMessage(
  messageBytes: Uint8Array,
  snapshot: Snapshot,
): DecodeResult<DecodedTransactionMessage> {
  const compiled = decodeCompiledMessage(messageBytes);
  if (!compiled.ok) return compiled;
  const resolved = resolveMessage(compiled.value, snapshot);
  if (!resolved.ok) return resolved;

  const instructions: ClassifiedInstruction[] = [];
  for (const ix of resolved.value.instructions) {
    const classified = classifyInstruction(ix);
    if (!classified.ok) return { ...classified, version: compiled.value.version };
    instructions.push(classified.value);
  }

  const { version, header, staticAccounts, lifetimeToken, config } = compiled.value;
  const first = instructions[0];
  return {
    ok: true,
    value: {
      version,
      feePayer: staticAccounts[0] as DecodedTransactionMessage['feePayer'],
      requiredSigners: staticAccounts.slice(0, header.numSignerAccounts),
      lifetime: {
        type: first?.program === 'system' && first.advancesNonce ? 'nonce' : 'blockhash',
        token: lifetimeToken,
      },
      accountKeys: resolved.value.accountKeys,
      lookupTableEntries: resolved.value.lookupTableEntries,
      instructions,
      transfers: collectTransfers(instructions),
      fees: collectFees(version, config, instructions),
    },
  };
}
