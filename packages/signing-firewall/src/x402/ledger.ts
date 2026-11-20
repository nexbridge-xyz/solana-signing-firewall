import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { type Address, isAddress } from '@solana/kit';

import type { Reason } from '../reasons.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const LEDGER_SCHEMA = 'solana-signing-firewall.budget-ledger/v0';

/** One payment the guard let the inner signer sign. It counts as spent from that moment. */
export type Reservation = {
  readonly time: string;
  readonly mint: Address;
  readonly amount: bigint;
  readonly payee: Address;
  readonly requirementsDigest: string;
  readonly messageDigest: string;
};

export type BudgetLimits = {
  /** Spent and reserved in the last 24 hours, per mint, plus the new amount, at most this. */
  readonly maxPerDay: bigint;
  /** Payments in the last 60 seconds, all mints together, fewer than this. */
  readonly maxPaymentsPerMinute: number;
};

export type LedgerUsage = {
  readonly reservedLast24h: bigint;
  readonly paymentsLastMinute: number;
};

/**
 * Where the x402 guard keeps its budget. A reservation is made just before the
 * inner signer is called. v0.1.0 never releases a reservation, even when the
 * payment does not land: the ledger fails closed.
 */
export interface BudgetLedger {
  usage(mint: Address, now: Date): LedgerUsage;
  /** Checks the limits and records the reservation in one step. Returns the failing reasons, or [] when reserved. */
  reserve(reservation: Reservation, limits: BudgetLimits, now: Date): Promise<Reason[]>;
  reservations(): Promise<readonly Reservation[]>;
}

export function usageOf(records: readonly Reservation[], mint: Address, now: Date): LedgerUsage {
  const t = now.getTime();
  let reservedLast24h = 0n;
  let paymentsLastMinute = 0;
  for (const record of records) {
    const age = t - Date.parse(record.time);
    if (age < 0) continue;
    if (age < DAY_MS && record.mint === mint) reservedLast24h += record.amount;
    if (age < MINUTE_MS) paymentsLastMinute += 1;
  }
  return { reservedLast24h, paymentsLastMinute };
}

export function limitReasons(usage: LedgerUsage, amount: bigint, limits: BudgetLimits): Reason[] {
  const reasons: Reason[] = [];
  if (usage.reservedLast24h + amount > limits.maxPerDay) {
    reasons.push({
      code: 'X402_BUDGET_EXCEEDED',
      detail: `${usage.reservedLast24h} spent or reserved in 24 hours + ${amount} > ${limits.maxPerDay}`,
    });
  }
  if (usage.paymentsLastMinute >= limits.maxPaymentsPerMinute) {
    reasons.push({
      code: 'X402_RATE_LIMIT_EXCEEDED',
      detail: `${usage.paymentsLastMinute} payments in the last minute; limit ${limits.maxPaymentsPerMinute}`,
    });
  }
  return reasons;
}

/** An in-memory ledger. JavaScript runs `reserve` without yielding, so overlapping calls cannot both pass. */
export function createMemoryLedger(initial: readonly Reservation[] = []): BudgetLedger {
  const records: Reservation[] = [...initial];
  return {
    usage: (mint, now) => usageOf(records, mint, now),
    reserve(reservation, limits, now) {
      const reasons = limitReasons(
        usageOf(records, reservation.mint, now),
        reservation.amount,
        limits,
      );
      if (reasons.length === 0) records.push(reservation);
      return Promise.resolve(reasons);
    },
    reservations: () => Promise.resolve([...records]),
  };
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

function parseLedgerFile(text: string, path: string): Reservation[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LedgerError(`${path} is not valid JSON; refusing to start`);
  }
  const file = json as { schema?: unknown; reservations?: unknown };
  if (file.schema !== LEDGER_SCHEMA || !Array.isArray(file.reservations)) {
    throw new LedgerError(`${path} is not a ${LEDGER_SCHEMA} file; refusing to start`);
  }
  return file.reservations.map((entry, i) => {
    const r = entry as Record<string, unknown>;
    const ok =
      typeof r.time === 'string' &&
      !Number.isNaN(Date.parse(r.time)) &&
      typeof r.mint === 'string' &&
      isAddress(r.mint) &&
      typeof r.amount === 'string' &&
      /^(0|[1-9][0-9]*)$/.test(r.amount) &&
      typeof r.payee === 'string' &&
      isAddress(r.payee) &&
      typeof r.requirementsDigest === 'string' &&
      typeof r.messageDigest === 'string';
    if (!ok) throw new LedgerError(`${path}: reservation ${i} is malformed; refusing to start`);
    return { ...(r as Omit<Reservation, 'amount'>), amount: BigInt(r.amount as string) };
  });
}

function serialize(records: readonly Reservation[]): string {
  return `${JSON.stringify(
    {
      schema: LEDGER_SCHEMA,
      reservations: records.map((r) => ({ ...r, amount: r.amount.toString() })),
    },
    null,
    2,
  )}\n`;
}

/**
 * A ledger kept in a JSON file, for one process only. It takes `<path>.lock`
 * (exclusive create) and refuses to start if the lock exists or the file is
 * malformed. Every reservation is written to a temporary file that is then
 * renamed over the ledger. Anyone who can edit the file can reset the budget.
 */
export async function openFileLedger(
  path: string,
): Promise<BudgetLedger & { close(): Promise<void> }> {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch {
    throw new LedgerError(
      `${lockPath} exists: another process holds the ledger, or one crashed. Refusing to start.`,
    );
  }
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();

  let records: Reservation[];
  try {
    const text = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
      throw error;
    });
    records = text === undefined ? [] : parseLedgerFile(text, path);
  } catch (error) {
    await unlink(lockPath);
    throw error;
  }

  // Serializes reservations inside this process; the lock file keeps other processes out.
  let queue: Promise<unknown> = Promise.resolve();
  let sequence = 0;
  const persist = async (next: Reservation[]) => {
    const temporary = `${path}.${process.pid}.${(sequence += 1)}.tmp`;
    await writeFile(temporary, serialize(next));
    await rename(temporary, path);
  };

  return {
    usage: (mint, now) => usageOf(records, mint, now),
    reserve(reservation, limits, now) {
      const run = queue.then(async () => {
        const reasons = limitReasons(
          usageOf(records, reservation.mint, now),
          reservation.amount,
          limits,
        );
        if (reasons.length > 0) return reasons;
        const next = [...records, reservation];
        await persist(next); // If this throws, nothing is reserved and nothing is signed.
        records = next;
        return [];
      });
      queue = run.catch(() => undefined);
      return run;
    },
    reservations: () => Promise.resolve([...records]),
    async close() {
      await queue;
      await unlink(lockPath);
    },
  };
}
