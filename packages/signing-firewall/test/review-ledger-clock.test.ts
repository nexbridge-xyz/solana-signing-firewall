// Security review, guarantee G4: the daily budget and the rate limit bound what the agent's key
// signs, and a reservation is never released by itself.
//
// A reservation dated after "now" can only mean that the clock moved back (an NTP step, a
// restored virtual machine, a clock set by hand) or that the file was edited. Leaving such a
// reservation out of the totals releases it: the whole daily budget and the rate limit come back
// the moment the clock steps back, without anyone touching the ledger file.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { type Address, address } from '@solana/kit';

import { type Reservation, createMemoryLedger, openFileLedger, usageOf } from '../src/index.js';

const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const payee = address('CZcNunzw25bmfcnwPT2nKugfpcVx6ULu5js14QTjckGM');
const limits = { maxPerDay: 50_000n, maxPaymentsPerMinute: 2 };
const noon = new Date('2026-11-20T12:00:00.000Z');
const anHourEarlier = new Date(noon.getTime() - 60 * 60 * 1000);

const reservation = (at: Date, amount: bigint, i = 0, m: Address = mint): Reservation => ({
  time: at.toISOString(),
  mint: m,
  amount,
  payee,
  requirementsDigest: '0'.repeat(64),
  messageDigest: i.toString(16).padStart(64, '0'),
});

describe('the budget when the clock moves back', () => {
  it('still counts a reservation made "later" than now (memory ledger)', async () => {
    const ledger = createMemoryLedger();
    expect(await ledger.reserve(reservation(noon, 50_000n), limits, noon)).toEqual([]);
    // The clock steps back one hour. The day's budget is spent and must stay spent.
    expect(ledger.usage(mint, anHourEarlier).reservedLast24h).toBe(50_000n);
    const again = await ledger.reserve(
      reservation(anHourEarlier, 50_000n, 1),
      limits,
      anHourEarlier,
    );
    expect(again.map((r) => r.code)).toContain('X402_BUDGET_EXCEEDED');
    expect((await ledger.reservations()).length).toBe(1);
  });

  it('still applies the rate limit after the clock moves back', async () => {
    const ledger = createMemoryLedger();
    await ledger.reserve(reservation(noon, 1n, 0), limits, noon);
    await ledger.reserve(reservation(noon, 1n, 1), limits, noon);
    const thirty = new Date(noon.getTime() - 30_000);
    expect(ledger.usage(mint, thirty).paymentsLastMinute).toBe(2);
    const third = await ledger.reserve(reservation(thirty, 1n, 2), limits, thirty);
    expect(third.map((r) => r.code)).toEqual(['X402_RATE_LIMIT_EXCEEDED']);
  });

  it('still counts it after a restart (file ledger)', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'review-ledger-')), 'budget.json');
    const first = await openFileLedger(path);
    expect(await first.reserve(reservation(noon, 50_000n), limits, noon)).toEqual([]);
    await first.close();

    const second = await openFileLedger(path);
    try {
      const again = await second.reserve(reservation(anHourEarlier, 1n, 1), limits, anHourEarlier);
      expect(again.map((r) => r.code)).toContain('X402_BUDGET_EXCEEDED');
    } finally {
      await second.close();
    }
  });

  it('counts a reservation from the future towards both windows, whatever its distance', () => {
    const records = [reservation(new Date(noon.getTime() + 365 * 24 * 60 * 60 * 1000), 7n)];
    expect(usageOf(records, mint, noon)).toEqual({ reservedLast24h: 7n, paymentsLastMinute: 1 });
  });
});
