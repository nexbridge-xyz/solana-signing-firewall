import {
  type Address,
  type Instruction,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type V1TransactionConfig,
} from '@solana/kit';
import { getAddressLookupTableEncoder } from '@solana-program/address-lookup-table';

import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  type Snapshot,
  type SnapshotAccount,
} from '../src/index.js';

export const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(9)) as Blockhash;

export async function addresses(count: number): Promise<Address[]> {
  return Promise.all(
    Array.from({ length: count }, async () => (await generateKeyPairSigner()).address),
  );
}

export function emptySnapshot(slot = 100n): Snapshot {
  return { slot, accounts: new Map() };
}

export function snapshotWith(accounts: [Address, SnapshotAccount][], slot = 100n): Snapshot {
  return { slot, accounts: new Map(accounts) };
}

export function lookupTableAccount(
  entries: Address[],
  options: {
    deactivationSlot?: bigint;
    lastExtendedSlot?: bigint;
    lastExtendedSlotStartIndex?: number;
  } = {},
): SnapshotAccount {
  const data = getAddressLookupTableEncoder().encode({
    deactivationSlot: options.deactivationSlot ?? 0xffff_ffff_ffff_ffffn,
    lastExtendedSlot: options.lastExtendedSlot ?? 1n,
    lastExtendedSlotStartIndex: options.lastExtendedSlotStartIndex ?? 0,
    authority: null,
    addresses: entries,
  });
  return {
    owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
    lamports: 1_000_000n,
    data: new Uint8Array(data),
    executable: false,
  };
}

type Built = { bytes: Uint8Array };

export function legacyMessage(feePayer: Address, instructions: Instruction[]): Built {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return {
    bytes: new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)),
    ),
  };
}

export function v0Message(
  feePayer: Address,
  instructions: Instruction[],
  lookupTables: Record<Address, Address[]> = {},
): Built {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, lookupTables),
  );
  return {
    bytes: new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)),
    ),
  };
}

export function v1Message(
  feePayer: Address,
  instructions: Instruction[],
  config: V1TransactionConfig,
): Built {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => setTransactionMessageConfig(config, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return {
    bytes: new Uint8Array(
      getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)),
    ),
  };
}
