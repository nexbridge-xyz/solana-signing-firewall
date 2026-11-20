import { BATCH_DISCRIMINATOR } from '@solana-program/token';

/** One sub-instruction of a P-Token `batch`, as positions into the batch's own account list. */
export type TokenBatchEntry = {
  readonly accountOffset: number;
  readonly accountCount: number;
  readonly data: Uint8Array;
};

/**
 * Strict parser for the P-Token `batch` instruction (discriminator 255).
 *
 * Layout after the discriminator, repeated until the data ends (no count prefix):
 * a u8 account count, a u8 data length, then that many data bytes, which start
 * with the sub-instruction's own discriminator. Accounts are consumed left to
 * right from the outer instruction's single account list; each sub-instruction
 * sees those accounts with the outer signer and writable flags.
 *
 * Stricter than the program: an empty batch, an entry with no data, and accounts
 * that no entry consumes are all rejected. (The program ignores trailing accounts.)
 */
export function parseTokenBatch(
  data: Uint8Array,
  outerAccountCount: number,
): { ok: true; entries: TokenBatchEntry[] } | { ok: false; detail: string } {
  if (data[0] !== BATCH_DISCRIMINATOR) return { ok: false, detail: 'not a batch instruction' };
  if (data.length === 1) return { ok: false, detail: 'empty batch' };
  const entries: TokenBatchEntry[] = [];
  let offset = 1;
  let accountOffset = 0;
  while (offset < data.length) {
    const accountCount = data[offset];
    const dataLength = data[offset + 1];
    if (accountCount === undefined || dataLength === undefined) {
      return { ok: false, detail: `entry ${entries.length}: truncated header at byte ${offset}` };
    }
    if (dataLength === 0) return { ok: false, detail: `entry ${entries.length}: no data` };
    const start = offset + 2;
    const end = start + dataLength;
    if (end > data.length) {
      return {
        ok: false,
        detail: `entry ${entries.length}: declares ${dataLength} data bytes, ${data.length - start} remain`,
      };
    }
    if (accountOffset + accountCount > outerAccountCount) {
      return {
        ok: false,
        detail: `entry ${entries.length}: needs ${accountCount} accounts, ${outerAccountCount - accountOffset} remain`,
      };
    }
    entries.push({ accountOffset, accountCount, data: data.slice(start, end) });
    offset = end;
    accountOffset += accountCount;
  }
  if (accountOffset !== outerAccountCount) {
    return {
      ok: false,
      detail: `${outerAccountCount - accountOffset} of ${outerAccountCount} accounts are not used by any entry`,
    };
  }
  return { ok: true, entries };
}
