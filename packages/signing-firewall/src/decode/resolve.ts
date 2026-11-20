import type { Address } from '@solana/kit';
import { getAddressLookupTableDecoder } from '@solana-program/address-lookup-table';

import { ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS } from '../programs.js';
import type { Reason } from '../reasons.js';
import type { Snapshot } from '../snapshot.js';
import { failure } from './compiled.js';
import type {
  AccountMeta,
  CompiledMessage,
  DecodeResult,
  LookupTableEntry,
  ResolvedMessage,
} from './types.js';

/** `deactivationSlot` of a lookup table that has not been deactivated. */
const ACTIVE_TABLE = 0xffff_ffff_ffff_ffffn;

type LoadedTable = { readonly addresses: readonly Address[]; readonly activeLength: number };

function loadTable(tableAddress: Address, snapshot: Snapshot): LoadedTable | string {
  const account = snapshot.accounts.get(tableAddress);
  if (account === undefined) return 'not in the snapshot';
  if (account === null) return 'does not exist';
  if (account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS) {
    return 'not owned by the Address Lookup Table program';
  }
  let table;
  try {
    table = getAddressLookupTableDecoder().decode(account.data);
  } catch {
    return 'account data is not a lookup table';
  }
  // Fail closed: a deactivating table still resolves on chain for a while, but we refuse it.
  if (table.deactivationSlot !== ACTIVE_TABLE) return 'deactivated';
  // Addresses appended in the snapshot slot are not usable until the next slot.
  const activeLength =
    snapshot.slot > table.lastExtendedSlot
      ? table.addresses.length
      : table.lastExtendedSlotStartIndex;
  return { addresses: table.addresses, activeLength };
}

function staticMeta(message: CompiledMessage, index: number, address: Address): AccountMeta {
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } =
    message.header;
  const isSigner = index < numSignerAccounts;
  const isWritable = isSigner
    ? index < numSignerAccounts - numReadonlySignerAccounts
    : index < message.staticAccounts.length - numReadonlyNonSignerAccounts;
  return { address, isSigner, isWritable };
}

/**
 * Stage 2: resolve every account index to an address and role. Lookup tables
 * come from the snapshot only. A missing table or index is LOOKUP_TABLE_UNRESOLVED.
 */
export function resolveMessage(
  message: CompiledMessage,
  snapshot: Snapshot,
): DecodeResult<ResolvedMessage> {
  const accountKeys: AccountMeta[] = message.staticAccounts.map((address, i) =>
    staticMeta(message, i, address),
  );

  const reasons: Reason[] = [];
  const writable: LookupTableEntry[] = [];
  const readonly: LookupTableEntry[] = [];
  for (const lookup of message.addressTableLookups) {
    const table = loadTable(lookup.lookupTableAddress, snapshot);
    if (typeof table === 'string') {
      reasons.push({
        code: 'LOOKUP_TABLE_UNRESOLVED',
        detail: `${lookup.lookupTableAddress}: ${table}`,
      });
      continue;
    }
    for (const [list, isWritable] of [
      [lookup.writableIndexes, true],
      [lookup.readonlyIndexes, false],
    ] as const) {
      for (const index of list) {
        const address = index < table.activeLength ? table.addresses[index] : undefined;
        if (address === undefined) {
          reasons.push({
            code: 'LOOKUP_TABLE_UNRESOLVED',
            detail: `${lookup.lookupTableAddress}: index ${index} is not active at slot ${snapshot.slot}`,
          });
          continue;
        }
        (isWritable ? writable : readonly).push({
          table: lookup.lookupTableAddress,
          index,
          address,
          writable: isWritable,
        });
      }
    }
  }
  if (reasons.length > 0) return { ok: false, version: message.version, reasons };

  // Runtime order: static accounts, then writable loaded accounts of every table, then read-only ones.
  const lookupTableEntries = [...writable, ...readonly];
  for (const entry of lookupTableEntries) {
    accountKeys.push({ address: entry.address, isSigner: false, isWritable: entry.writable });
  }
  if (new Set(accountKeys.map((key) => key.address)).size !== accountKeys.length) {
    return failure(message.version, 'MALFORMED_MESSAGE', 'an account is loaded twice');
  }

  const instructions = message.instructions.map((ix, i) => ({
    path: `ix[${i}]`,
    programAddress: message.staticAccounts[ix.programIndex] as Address,
    accounts: ix.accountIndices.map((index) => accountKeys[index] as AccountMeta),
    data: ix.data,
  }));
  return { ok: true, value: { compiled: message, accountKeys, lookupTableEntries, instructions } };
}
