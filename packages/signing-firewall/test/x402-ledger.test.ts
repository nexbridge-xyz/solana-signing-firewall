import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { type Address, address } from '@solana/kit';

import {
  LedgerError,
  type Reservation,
  createMemoryLedger,
  limitReasons,
  openFileLedger,
  usageOf,
} from '../src/index.js';

const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const other = address('11111111111111111111111111111111');
const payee = address('CZcNunzw25bmfcnwPT2nKugfpcVx6ULu5js14QTjckGM');
const now = new Date('2026-11-20T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const record = (time: string, amount: bigint, m: Address = mint): Reservation => ({
  time,
  mint: m,
  amount,
  payee,
  requirementsDigest: '0'.repeat(64),
  messageDigest: '1'.repeat(64),
});
const DAY = 24 * 60 * 60 * 1000;

describe('usageOf and limitReasons', () => {
  it('counts 24 hours per mint and 60 seconds across mints, without the boundaries or the future', () => {
    const records = [
      record(ago(DAY), 100n),
      record(ago(DAY - 1), 10n),
      record(ago(60_000), 1n),
      record(ago(59_999), 2n),
      record(ago(0), 3n, other),
      record(new Date(now.getTime() + 1).toISOString(), 1_000n),
    ];
    expect(usageOf(records, mint, now)).toEqual({ reservedLast24h: 13n, paymentsLastMinute: 2 });
    expect(usageOf(records, other, now)).toEqual({ reservedLast24h: 3n, paymentsLastMinute: 2 });
  });

  it('allows exactly the daily budget and one payment fewer than the rate', () => {
    const limits = { maxPerDay: 50_000n, maxPaymentsPerMinute: 3 };
    const usage = (reservedLast24h: bigint, paymentsLastMinute: number) => ({
      reservedLast24h,
      paymentsLastMinute,
    });
    expect(limitReasons(usage(30_000n, 2), 20_000n, limits)).toEqual([]);
    expect(limitReasons(usage(30_001n, 2), 20_000n, limits).map((r) => r.code)).toEqual([
      'X402_BUDGET_EXCEEDED',
    ]);
    expect(limitReasons(usage(0n, 3), 1n, limits).map((r) => r.code)).toEqual([
      'X402_RATE_LIMIT_EXCEEDED',
    ]);
  });

  it('keeps the memory ledger unchanged when it refuses', async () => {
    const ledger = createMemoryLedger([record(ago(1_000), 40_000n)]);
    const limits = { maxPerDay: 50_000n, maxPaymentsPerMinute: 10 };
    expect(await ledger.reserve(record(ago(0), 20_000n), limits, now)).not.toEqual([]);
    expect(ledger.usage(mint, now).reservedLast24h).toBe(40_000n);
    expect(await ledger.reserve(record(ago(0), 10_000n), limits, now)).toEqual([]);
    expect(ledger.usage(mint, now)).toEqual({ reservedLast24h: 50_000n, paymentsLastMinute: 2 });
  });
});

describe('the file ledger', () => {
  const fresh = async () => join(await mkdtemp(join(tmpdir(), 'ledger-')), 'budget.json');
  const file = (reservations: unknown) =>
    JSON.stringify({ schema: 'solana-signing-firewall.budget-ledger/v0', reservations });
  const good = { ...record(ago(1_000), 20_000n), amount: '20000' };

  it('reserves, reports usage, writes its process id in the lock, and reads its own file back', async () => {
    const path = await fresh();
    const ledger = await openFileLedger(path);
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(`${String(process.pid)}\n`);
    const limits = { maxPerDay: 50_000n, maxPaymentsPerMinute: 10 };
    expect(await ledger.reserve(record(ago(0), 20_000n), limits, now)).toEqual([]);
    expect(await ledger.reserve(record(ago(0), 40_000n), limits, now)).not.toEqual([]);
    expect(ledger.usage(mint, now)).toEqual({ reservedLast24h: 20_000n, paymentsLastMinute: 1 });
    await ledger.close();
    const again = await openFileLedger(path);
    expect(again.usage(mint, now).reservedLast24h).toBe(20_000n);
    await again.close();
  });

  it.each([
    ['not json', /is not valid JSON/],
    [JSON.stringify({ schema: 'other', reservations: [] }), /is not a solana-signing-firewall/],
    [JSON.stringify({ schema: 'solana-signing-firewall.budget-ledger/v0' }), /is not a solana/],
    [file([{ ...good, time: 'yesterday' }]), /reservation 0 is malformed/],
    [file([{ ...good, time: 5 }]), /reservation 0 is malformed/],
    [file([{ ...good, mint: 'nope' }]), /reservation 0 is malformed/],
    [file([{ ...good, mint: 5 }]), /reservation 0 is malformed/],
    [file([good, { ...good, amount: '020000' }]), /reservation 1 is malformed/],
    [file([{ ...good, amount: 'x20000' }]), /reservation 0 is malformed/],
    [file([{ ...good, amount: '20000x' }]), /reservation 0 is malformed/],
    [file([{ ...good, amount: 20000 }]), /reservation 0 is malformed/],
    [file([{ ...good, payee: 'nope' }]), /reservation 0 is malformed/],
    [file([{ ...good, payee: 5 }]), /reservation 0 is malformed/],
    [file([{ ...good, requirementsDigest: 5 }]), /reservation 0 is malformed/],
    [file([{ ...good, messageDigest: 5 }]), /reservation 0 is malformed/],
  ])('refuses a bad file and releases its lock (case %#)', async (text, message) => {
    const path = await fresh();
    await writeFile(path, text);
    await expect(openFileLedger(path)).rejects.toThrow(LedgerError);
    await expect(openFileLedger(path)).rejects.toThrow(message);
    await writeFile(path, file([good]));
    const ledger = await openFileLedger(path);
    expect((await ledger.reservations()).map((r) => r.amount)).toEqual([20_000n]);
    await ledger.close();
  });

  it('passes on read errors other than a missing file, and releases its lock', async () => {
    const path = await fresh();
    await mkdir(path);
    await expect(openFileLedger(path)).rejects.toThrow(/EISDIR|illegal operation/);
    await expect(openFileLedger(path)).rejects.not.toThrow(/exists: another process/);
  });
});
