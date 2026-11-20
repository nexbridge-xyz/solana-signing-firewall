import {
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK,
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK,
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK,
  decompileTransactionConfig,
  getCompiledTransactionMessageDecoder,
  getU32Decoder,
} from '@solana/kit';

import type { ReasonCode } from '../reasons.js';
import type {
  CompiledInstructionView,
  CompiledMessage,
  DecodeFailure,
  DecodeResult,
  MessageVersion,
} from './types.js';

/** Byte offset of `TransactionConfigMask` in a v1 message: version byte + 3-byte header (SIMD-0385). */
const V1_CONFIG_MASK_OFFSET = 4;
const V1_KNOWN_CONFIG_BITS =
  TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK |
  TRANSACTION_CONFIG_COMPUTE_UNIT_LIMIT_BIT_MASK |
  TRANSACTION_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_BIT_MASK |
  TRANSACTION_CONFIG_HEAP_SIZE_BIT_MASK;
/** SIMD-0385 sanitization limits for v1. */
const V1_MAX_ACCOUNTS = 64;
const V1_MAX_INSTRUCTIONS = 64;
const V1_MAX_SIGNATURES = 12;
const V1_MIN_HEAP_SIZE = 32 * 1024;
const V1_MAX_HEAP_SIZE = 256 * 1024;
/** Account indexes are u8, so a v0 message can reference at most 256 accounts. */
const MAX_TOTAL_ACCOUNTS = 256;

export function failure(
  version: MessageVersion | undefined,
  code: ReasonCode,
  detail: string,
): DecodeFailure {
  return { ok: false, version, reasons: [{ code, detail }] };
}

/** Version from the first byte: below 0x80 legacy, 0x80 v0, 0x81 v1, anything else unsupported. */
export function detectMessageVersion(bytes: Uint8Array): DecodeResult<MessageVersion> {
  const first = bytes[0];
  if (first === undefined) return failure(undefined, 'MALFORMED_MESSAGE', 'empty message');
  if (first < 0x80) return { ok: true, value: 'legacy' };
  if (first === 0x80) return { ok: true, value: 'v0' };
  if (first === 0x81) return { ok: true, value: 'v1' };
  return failure(undefined, 'UNSUPPORTED_VERSION', `version byte 0x${first.toString(16)}`);
}

function checkV1ConfigMask(bytes: Uint8Array): string | undefined {
  if (bytes.length < V1_CONFIG_MASK_OFFSET + 4) return 'message ends inside the v1 header';
  const mask = getU32Decoder().decode(bytes, V1_CONFIG_MASK_OFFSET);
  if ((mask & ~V1_KNOWN_CONFIG_BITS) >>> 0 !== 0) {
    return `transactionConfig mask sets unknown bits (0x${mask.toString(16)})`;
  }
  const feeBits = mask & TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK;
  if (feeBits !== 0 && feeBits !== TRANSACTION_CONFIG_PRIORITY_FEE_LAMPORTS_BIT_MASK) {
    return 'transactionConfig mask sets only one of the two priority-fee bits';
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stage 1: parse the message bytes with @solana/kit's codec, then apply the
 * runtime's sanitization rules. Never throws; any problem is MALFORMED_MESSAGE
 * or UNSUPPORTED_VERSION.
 */
export function decodeCompiledMessage(bytes: Uint8Array): DecodeResult<CompiledMessage> {
  const detected = detectMessageVersion(bytes);
  if (!detected.ok) return detected;
  const version = detected.value;

  if (version === 'v1') {
    const problem = checkV1ConfigMask(bytes);
    if (problem !== undefined) return failure(version, 'MALFORMED_MESSAGE', problem);
  }

  let message: CompiledMessage;
  try {
    const [compiled, offset] = getCompiledTransactionMessageDecoder().read(bytes, 0);
    if (offset !== bytes.length) {
      return failure(version, 'MALFORMED_MESSAGE', `${bytes.length - offset} trailing bytes`);
    }
    if (compiled.version === 1) {
      if (compiled.instructionHeaders.length !== compiled.instructionPayloads.length) {
        return failure(
          version,
          'MALFORMED_MESSAGE',
          'instruction headers and payloads differ in count',
        );
      }
      const instructions: CompiledInstructionView[] = compiled.instructionHeaders.map(
        (header, i) => {
          const payload = compiled.instructionPayloads[i];
          return {
            programIndex: header.programAccountIndex,
            accountIndices: payload?.instructionAccountIndices ?? [],
            data: new Uint8Array(payload?.instructionData ?? []),
          };
        },
      );
      message = {
        version,
        header: compiled.header,
        staticAccounts: compiled.staticAccounts,
        lifetimeToken: compiled.lifetimeToken,
        instructions,
        addressTableLookups: [],
        config: decompileTransactionConfig(compiled.configMask, compiled.configValues),
      };
    } else {
      message = {
        version,
        header: compiled.header,
        staticAccounts: compiled.staticAccounts,
        lifetimeToken: compiled.lifetimeToken,
        instructions: compiled.instructions.map((ix) => ({
          programIndex: ix.programAddressIndex,
          accountIndices: ix.accountIndices ?? [],
          data: new Uint8Array(ix.data ?? []),
        })),
        addressTableLookups: compiled.version === 0 ? (compiled.addressTableLookups ?? []) : [],
        config: undefined,
      };
    }
  } catch (error) {
    return failure(version, 'MALFORMED_MESSAGE', `does not decode: ${describeError(error)}`);
  }

  const problem = sanitize(message);
  if (problem !== undefined) return failure(version, 'MALFORMED_MESSAGE', problem);
  return { ok: true, value: message };
}

/** The runtime's message sanitization rules, plus the v1 limits of SIMD-0385. */
function sanitize(message: CompiledMessage): string | undefined {
  const { header, staticAccounts, instructions, addressTableLookups } = message;
  if (header.numSignerAccounts < 1) return 'no fee payer: zero required signatures';
  if (header.numReadonlySignerAccounts >= header.numSignerAccounts) {
    return 'the fee payer would be read-only';
  }
  if (header.numSignerAccounts + header.numReadonlyNonSignerAccounts > staticAccounts.length) {
    return 'header describes more accounts than the message lists';
  }
  if (new Set(staticAccounts).size !== staticAccounts.length) return 'duplicate static account';

  let loadedCount = 0;
  for (const lookup of addressTableLookups) {
    if (lookup.writableIndexes.length + lookup.readonlyIndexes.length === 0) {
      return `lookup ${lookup.lookupTableAddress} loads no addresses`;
    }
    loadedCount += lookup.writableIndexes.length + lookup.readonlyIndexes.length;
  }
  const totalAccounts = staticAccounts.length + loadedCount;
  if (totalAccounts > MAX_TOTAL_ACCOUNTS) return `${totalAccounts} accounts; at most 256`;

  for (const [i, ix] of instructions.entries()) {
    if (ix.programIndex === 0) return `ix[${i}]: the fee payer cannot be a program`;
    if (ix.programIndex >= staticAccounts.length) {
      return `ix[${i}]: program index ${ix.programIndex} is not a static account`;
    }
    for (const index of ix.accountIndices) {
      if (index >= totalAccounts) return `ix[${i}]: account index ${index} is out of range`;
    }
  }

  if (message.version === 'v1') {
    if (staticAccounts.length > V1_MAX_ACCOUNTS)
      return `v1: ${staticAccounts.length} accounts; at most 64`;
    if (instructions.length > V1_MAX_INSTRUCTIONS) {
      return `v1: ${instructions.length} instructions; at most 64`;
    }
    if (header.numSignerAccounts > V1_MAX_SIGNATURES) {
      return `v1: ${header.numSignerAccounts} signatures; at most 12`;
    }
    const heapSize = message.config?.heapSize;
    if (
      heapSize !== undefined &&
      (heapSize % 1024 !== 0 || heapSize < V1_MIN_HEAP_SIZE || heapSize > V1_MAX_HEAP_SIZE)
    ) {
      return `v1: heap size ${heapSize} is not a multiple of 1 KiB in [32 KiB, 256 KiB]`;
    }
  }
  return undefined;
}
