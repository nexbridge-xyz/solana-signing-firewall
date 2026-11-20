import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type Address,
  type KeyPairSigner,
  type TransactionPartialSigner,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token';

import {
  type BudgetLedger,
  LedgerError,
  PolicyViolationError,
  type Reservation,
  SPL_MEMO_PROGRAM_ADDRESS,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  VerifierConfigError,
  createMemoryLedger,
  createX402Guard,
  openFileLedger,
  parsePolicy,
  parseVerifierConfig,
  staticSnapshotLoader,
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';
import { mintData, tokenData } from './world.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const now = new Date('2026-11-20T00:00:00.000Z');

const agent = await generateKeyPairSigner();
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const mint = (await generateKeyPairSigner()).address;
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const agentAta = await ata(agent.address);
const shopAta = await ata(shop);

const policy = parsePolicy({
  schema: 'solana-signing-firewall.policy/v0',
  policyId: 'agent',
  network: 'localnet',
  signer: agent.address,
  feePayers: [feePayer],
  messageVersions: ['v0', 'v1'],
  mints: { [mint]: { decimals: 6, maxPerTransaction: '20000' } },
  sources: [agentAta],
  recipients: { owners: [shop] },
  fees: { maxComputeUnitLimit: 200000, maxPriorityFeeLamports: '50000' },
  memo: { allowed: true, maxBytes: 256 },
  x402: {
    networks: [DEVNET],
    maxTimeoutSeconds: 120,
    maxComputeUnitPriceMicroLamports: '5000000',
    budgets: { [mint]: { maxPerDay: '50000' } },
    maxPaymentsPerMinute: 10,
  },
});

const owned = (data: Uint8Array): SnapshotAccount => ({
  owner: TOKEN_PROGRAM_ADDRESS,
  lamports: 2_039_280n,
  data,
  executable: false,
});
const loader = staticSnapshotLoader({
  slot: 1n,
  accounts: new Map<Address, SnapshotAccount | null>([
    [mint, owned(mintData())],
    [agentAta, owned(tokenData(mint, agent.address, 1_000_000n))],
    [shopAta, owned(tokenData(mint, shop, 0n))],
  ]),
});

const quote = (amount = '20000') => ({
  scheme: 'exact',
  network: DEVNET,
  amount,
  asset: mint,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra: { feePayer, transactionVersions: [0] },
});

/** The SDK's version-0 layout, built here so the core tests need no SDK. */
function paymentFor(signer: TransactionPartialSigner, amount = 20_000n, nonce = 'a'.repeat(32)) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 20_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1n }),
          getTransferCheckedInstruction({
            source: agentAta,
            mint,
            destination: shopAta,
            authority: signer,
            amount,
            decimals: 6,
          }),
          { programAddress: SPL_MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode(nonce) },
        ],
        m,
      ),
  );
  const transaction = compileTransaction(message);
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

function counting(inner: KeyPairSigner) {
  let calls = 0;
  const signer: TransactionPartialSigner = {
    address: inner.address,
    signTransactions: (transactions) => {
      calls += 1;
      return inner.signTransactions(transactions);
    },
  };
  return { signer, calls: () => calls };
}

async function codes(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolicyViolationError) return error.reasons.map((r) => r.code);
    throw error;
  }
  return [];
}

const reservation = (amount: bigint, at: Date, i = 0): Reservation => ({
  time: at.toISOString(),
  mint,
  amount,
  payee: shop,
  requirementsDigest: '0'.repeat(64),
  messageDigest: i.toString(16).padStart(64, '0'),
});

describe('budget ledgers', () => {
  const limits = { maxPerDay: 50_000n, maxPaymentsPerMinute: 10 };

  it('counts 24 hours per mint and 60 seconds for the rate', async () => {
    const ledger = createMemoryLedger([
      reservation(30_000n, new Date(now.getTime() - 25 * 3_600_000)),
      reservation(30_000n, new Date(now.getTime() - 3_600_000)),
    ]);
    expect(ledger.usage(mint, now)).toEqual({ reservedLast24h: 30_000n, paymentsLastMinute: 0 });
    expect(
      (await ledger.reserve(reservation(20_000n, now), limits, now)).map((r) => r.code),
    ).toEqual([]);
    expect((await ledger.reserve(reservation(1n, now), limits, now)).map((r) => r.code)).toEqual([
      'X402_BUDGET_EXCEEDED',
    ]);
  });

  const overlapping = async (ledger: BudgetLedger, amounts: bigint[]) => {
    await Promise.all(amounts.map((a, i) => ledger.reserve(reservation(a, now, i), limits, now)));
    const kept = await ledger.reservations();
    const total = kept.reduce((sum, r) => sum + r.amount, 0n);
    expect(total <= limits.maxPerDay).toBe(true);
    expect(kept.length <= limits.maxPaymentsPerMinute).toBe(true);
  };

  it('never lets overlapping reservations exceed the limits (memory)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 30_000n }), { maxLength: 30 }),
        (amounts) => overlapping(createMemoryLedger(), amounts),
      ),
      { numRuns: 200 },
    );
  });

  it('never lets overlapping reservations exceed the limits (file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    let n = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 30_000n }), { maxLength: 20 }),
        async (amounts) => {
          const ledger = await openFileLedger(join(dir, `ledger-${(n += 1)}.json`));
          await overlapping(ledger, amounts);
          await ledger.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('persists, takes a lock, refuses a malformed file, and leaves no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'budget.json');
    const ledger = await openFileLedger(path);
    await expect(openFileLedger(path)).rejects.toThrow(LedgerError);
    await ledger.reserve(reservation(20_000n, now), limits, now);
    await ledger.close();
    const reopened = await openFileLedger(path);
    expect((await reopened.reservations()).map((r) => r.amount)).toEqual([20_000n]);
    await reopened.close();
    expect((await readdir(dir)).sort()).toEqual(['budget.json']);
    await writeFile(path, '{"schema":"something else"}');
    await expect(openFileLedger(path)).rejects.toThrow(/refusing to start/);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schema: 'something else' });
  });
});

describe('createX402Guard', () => {
  it('refuses a signer for another address, and a policy without an x402 section', async () => {
    const other = await generateKeyPairSigner();
    expect(() =>
      createX402Guard({ inner: other, policy, loader, ledger: createMemoryLedger() }),
    ).toThrow(/SIGNER_ADDRESS_MISMATCH/);
    const plain = { ...policy, x402: undefined };
    expect(() =>
      createX402Guard({ inner: agent, policy: plain, loader, ledger: createMemoryLedger() }),
    ).toThrow(/x402/);
  });

  it('pays the quoted option once, reserving the budget before the key signs', async () => {
    const inner = counting(agent);
    const ledger = createMemoryLedger();
    const guard = createX402Guard({ inner: inner.signer, policy, loader, ledger, now: () => now });
    expect(
      guard.checkRequirements([quote(), { ...quote(), payTo: feePayer }]).map((d) => d.outcome),
    ).toEqual(['allow', 'deny']);

    const bound = guard.signerFor(quote());
    const [signatures] = await bound.signTransactions([paymentFor(bound)]);
    expect(Object.keys(signatures ?? {})).toEqual([agent.address]);
    expect(inner.calls()).toBe(1);
    expect((await ledger.reservations()).map((r) => r.amount)).toEqual([20_000n]);

    expect(await codes(bound.signTransactions([paymentFor(bound)]))).toEqual([
      'X402_SIGNER_ALREADY_USED',
    ]);
    expect(inner.calls()).toBe(1);
  });

  it('refuses bytes that differ from the quote without calling the key', async () => {
    const inner = counting(agent);
    const guard = createX402Guard({
      inner: inner.signer,
      policy,
      loader,
      ledger: createMemoryLedger(),
      now: () => now,
    });
    const bound = guard.signerFor(quote('10000'));
    expect(await codes(bound.signTransactions([paymentFor(bound, 20_000n)]))).toEqual([
      'X402_AMOUNT_MISMATCH',
    ]);
    const memo = guard.signerFor(quote());
    expect(await codes(memo.signTransactions([paymentFor(memo, 20_000n, 'not a nonce')]))).toEqual([
      'X402_MEMO_MISMATCH',
    ]);
    expect(inner.calls()).toBe(0);
  });

  it('stops at the daily budget (scene 14)', async () => {
    const inner = counting(agent);
    const ledger = createMemoryLedger([reservation(20_000n, new Date(now.getTime() - 60_000))]);
    const guard = createX402Guard({ inner: inner.signer, policy, loader, ledger, now: () => now });
    const second = guard.signerFor(quote());
    await second.signTransactions([paymentFor(second)]);
    expect(guard.checkRequirements([quote()])[0]?.reasons.map((r) => r.code)).toEqual([
      'X402_BUDGET_EXCEEDED',
    ]);
    const third = guard.signerFor(quote());
    expect(await codes(third.signTransactions([paymentFor(third)]))).toEqual([
      'X402_BUDGET_EXCEEDED',
    ]);
    expect(inner.calls()).toBe(1);
  });
});

describe('parseVerifierConfig', () => {
  const config = {
    schema: 'solana-signing-firewall.x402-verifier/v0',
    networks: [DEVNET],
    feePayers: [feePayer],
    messageVersions: ['v0', 'v1'],
    assets: { [mint]: { decimals: 6 } },
    maxComputeUnitLimit: 200000,
    maxComputeUnitPriceMicroLamports: '5000000',
    maxPriorityFeeLamports: '100000',
    maxRequiredSignatures: 2,
  };
  it('accepts the demo config with strict defaults', () => {
    expect(parseVerifierConfig(config).lookupTables).toBe('deny');
  });
  it.each([
    [{ ...config, extra: 1 }, /unknown field extra/],
    [{ ...config, messageVersions: ['legacy'] }, /not "v0" or "v1"/],
    [{ ...config, maxPriorityFeeLamports: 100 }, /decimal string/],
    [{ ...config, lookupTables: 'allow' }, /must be "deny"/],
  ])('rejects %#', (bad, message) => {
    expect(() => parseVerifierConfig(bad)).toThrow(VerifierConfigError);
    expect(() => parseVerifierConfig(bad)).toThrow(message);
  });
});
