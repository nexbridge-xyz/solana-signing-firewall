import type { Address } from '@solana/kit';

import type { Reason } from '../reasons.js';

export type MessageVersion = 'legacy' | 'v0' | 'v1';

export type MessageHeader = {
  readonly numSignerAccounts: number;
  readonly numReadonlySignerAccounts: number;
  readonly numReadonlyNonSignerAccounts: number;
};

/** An instruction as compiled into the message: indexes into the account list. */
export type CompiledInstructionView = {
  readonly programIndex: number;
  readonly accountIndices: readonly number[];
  readonly data: Uint8Array;
};

export type AddressTableLookupView = {
  readonly lookupTableAddress: Address;
  readonly writableIndexes: readonly number[];
  readonly readonlyIndexes: readonly number[];
};

/** Version-1 `transactionConfig` values. Unset fields are absent (the runtime then uses 0). */
export type TransactionConfig = {
  readonly computeUnitLimit?: number;
  readonly loadedAccountsDataSizeLimit?: number;
  readonly heapSize?: number;
  readonly priorityFeeLamports?: bigint;
};

/** Stage 1: the message bytes, parsed and structurally checked. No on-chain state needed. */
export type CompiledMessage = {
  readonly version: MessageVersion;
  readonly header: MessageHeader;
  readonly staticAccounts: readonly Address[];
  /** Recent blockhash, or the nonce value for a durable-nonce transaction (base58). */
  readonly lifetimeToken: string;
  readonly instructions: readonly CompiledInstructionView[];
  /** v0 only; empty otherwise. */
  readonly addressTableLookups: readonly AddressTableLookupView[];
  /** v1 only. */
  readonly config: TransactionConfig | undefined;
};

export type AccountMeta = {
  readonly address: Address;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
};

export type LookupTableEntry = {
  readonly table: Address;
  readonly index: number;
  readonly address: Address;
  readonly writable: boolean;
};

export type ResolvedInstruction = {
  readonly path: string;
  readonly programAddress: Address;
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
};

/** Stage 2: account indexes resolved, including entries loaded from lookup tables. */
export type ResolvedMessage = {
  readonly compiled: CompiledMessage;
  readonly accountKeys: readonly AccountMeta[];
  readonly lookupTableEntries: readonly LookupTableEntry[];
  readonly instructions: readonly ResolvedInstruction[];
};

export type Transfer = {
  readonly path: string;
  readonly source: Address;
  readonly mint: Address;
  readonly destination: Address;
  readonly authority: Address;
  /** Accounts after the authority: multisig co-signers. */
  readonly multisigSigners: readonly Address[];
  readonly amount: bigint;
  readonly decimals: number;
};

export type TokenInstructionView =
  | { readonly type: 'transfer-checked'; readonly transfer: Transfer }
  | { readonly type: 'batch'; readonly entries: readonly TokenBatchEntryView[] }
  | { readonly type: 'other'; readonly name: string | undefined; readonly detail?: string };

export type TokenBatchEntryView = {
  readonly path: string;
  readonly instruction: TokenInstructionView;
};

export type ComputeBudgetView =
  | { readonly type: 'set-compute-unit-limit'; readonly units: number }
  | { readonly type: 'set-compute-unit-price'; readonly microLamports: bigint }
  | { readonly type: 'other'; readonly name: string | undefined; readonly detail?: string };

export type ClassifiedInstruction = {
  readonly path: string;
  readonly programAddress: Address;
  readonly accounts: readonly AccountMeta[];
  readonly data: Uint8Array;
} & (
  | { readonly program: 'spl-token'; readonly token: TokenInstructionView }
  | { readonly program: 'token-2022' }
  | { readonly program: 'compute-budget'; readonly computeBudget: ComputeBudgetView }
  | { readonly program: 'memo' }
  | { readonly program: 'system'; readonly advancesNonce: boolean }
  | { readonly program: 'other' }
);

export type Fees =
  | {
      readonly source: 'instructions';
      readonly computeUnitLimit: number | undefined;
      readonly computeUnitPriceMicroLamports: bigint | undefined;
    }
  | {
      readonly source: 'transactionConfig';
      readonly computeUnitLimit: number | undefined;
      readonly loadedAccountsDataSizeLimit: number | undefined;
      readonly heapSize: number | undefined;
      readonly priorityFeeLamports: bigint;
    };

/** Everything `review()` needs from the message itself. */
export type DecodedTransactionMessage = {
  readonly version: MessageVersion;
  readonly feePayer: Address;
  readonly requiredSigners: readonly Address[];
  readonly lifetime: { readonly type: 'blockhash' | 'nonce'; readonly token: string };
  readonly accountKeys: readonly AccountMeta[];
  readonly lookupTableEntries: readonly LookupTableEntry[];
  readonly instructions: readonly ClassifiedInstruction[];
  /** Every SPL Token TransferChecked, top level and inside `batch`, in message order. */
  readonly transfers: readonly Transfer[];
  readonly fees: Fees;
};

export type DecodeFailure = {
  readonly ok: false;
  readonly version: MessageVersion | undefined;
  readonly reasons: readonly Reason[];
};

export type DecodeResult<T> = { readonly ok: true; readonly value: T } | DecodeFailure;
