// Security review: nothing fails open. Whenever a check fails, throws or never returns, the inner
// signer is not called; and the x402 bound signer never calls the key without a reservation.
// These properties hold at the reviewed commit.
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
  PolicyViolationError,
  SPL_MEMO_PROGRAM_ADDRESS,
  type Snapshot,
  type SnapshotAccount,
  type SnapshotLoader,
  TOKEN_PROGRAM_ADDRESS,
  createMemoryLedger,
  createX402Guard,
  parsePolicy,
  review,
  staticSnapshotLoader,
  withPolicy,
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';
import {
  mintData,
  policyFor,
  snapshotFor,
  testWorld,
  tokenData,
  transferTransaction,
} from './world.js';

const now = () => new Date('2026-11-20T00:00:00.000Z');

function counting(inner: KeyPairSigner) {
  let calls = 0;
  const signer: TransactionPartialSigner = {
    address: inner.address,
    signTransactions(transactions, config) {
      calls += 1;
      return inner.signTransactions(transactions, config);
    },
  };
  return { signer, calls: () => calls };
}

/** Rejects after `ms` if the promise is still pending: the caller gave up waiting. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still pending'> {
  return Promise.race([
    promise,
    new Promise<'still pending'>((resolve) => {
      setTimeout(() => {
        resolve('still pending');
      }, ms);
    }),
  ]);
}

describe('withPolicy(): no failure ends with the inner signer called', async () => {
  const w = await testWorld();
  const policy = policyFor(w);
  const good = staticSnapshotLoader(snapshotFor(w));

  it('a loader that throws, or returns nothing usable', async () => {
    for (const loader of [
      { load: () => Promise.reject(new Error('RPC down')) },
      { load: () => Promise.resolve(undefined as unknown as Snapshot) },
      { load: () => Promise.resolve({ slot: 1n, accounts: new Map() }) },
      { load: () => Promise.resolve({ slot: 1n } as unknown as Snapshot) },
    ] as SnapshotLoader[]) {
      const inner = counting(w.treasury);
      const wrapped = withPolicy(inner.signer, { policy, loader, now });
      await expect(
        wrapped.signTransactions([transferTransaction(w, 1_000_000n)]),
      ).rejects.toThrow();
      expect(inner.calls()).toBe(0);
    }
  });

  it('a loader that never answers (a timeout on the caller side)', async () => {
    const inner = counting(w.treasury);
    const loader: SnapshotLoader = { load: () => new Promise(() => undefined) };
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const pending = wrapped.signTransactions([transferTransaction(w, 1_000_000n)]);
    expect(await within(pending, 150)).toBe('still pending');
    expect(inner.calls()).toBe(0);
  });

  it('an approval lookup that throws, returns junk, or never answers', async () => {
    const needsApproval = () => transferTransaction(w, 3_000_000n);
    for (const approvals of [
      () => {
        throw new Error('store down');
      },
      () => Promise.reject(new Error('store down')),
      () => ({ approved: true }) as never,
      () => 'yes' as never,
      () => null as never,
    ]) {
      const inner = counting(w.treasury);
      const wrapped = withPolicy(inner.signer, { policy, loader: good, now, approvals });
      await expect(wrapped.signTransactions([needsApproval()])).rejects.toThrow();
      expect(inner.calls()).toBe(0);
    }
    const inner = counting(w.treasury);
    const never = withPolicy(inner.signer, {
      policy,
      loader: good,
      now,
      approvals: () => new Promise(() => undefined),
    });
    expect(await within(never.signTransactions([needsApproval()]), 150)).toBe('still pending');
    expect(inner.calls()).toBe(0);
  });

  it('a decision callback that throws', async () => {
    const inner = counting(w.treasury);
    const wrapped = withPolicy(inner.signer, {
      policy,
      loader: good,
      now,
      onDecision: () => {
        throw new Error('logger down');
      },
    });
    await expect(wrapped.signTransactions([transferTransaction(w, 1_000_000n)])).rejects.toThrow();
    expect(inner.calls()).toBe(0);
  });

  it('one refused transaction anywhere in a call: none of them is signed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        async (allowedFlags) => {
          const inner = counting(w.treasury);
          const wrapped = withPolicy(inner.signer, { policy, loader: good, now });
          const batch = allowedFlags.map((allowed) =>
            transferTransaction(w, allowed ? 1_000_000n : 6_000_000n),
          );
          const result = await wrapped.signTransactions(batch).then(
            (signed) => signed.length,
            (error: unknown) => (error instanceof PolicyViolationError ? 'refused' : 'crashed'),
          );
          if (allowedFlags.every(Boolean)) {
            expect(result).toBe(batch.length);
            expect(inner.calls()).toBe(1);
          } else {
            expect(result).toBe('refused');
            expect(inner.calls()).toBe(0);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('a signer that can only rewrite-and-sign, or only sign-and-send, is refused when it is wrapped', () => {
    // The shapes Keychain 2.0.0 returns for Fordefi with `chain` (manual and automatic push)
    // and for Crossmint: exactly one signing method each, and it is not signTransactions.
    const shapes = [
      { address: w.treasury.address, modifyAndSignTransactions: () => Promise.resolve([]) },
      { address: w.treasury.address, signAndSendTransactions: () => Promise.resolve([]) },
      { address: w.treasury.address, signMessages: () => Promise.resolve([]) },
      { address: w.treasury.address },
    ];
    for (const shape of shapes) {
      expect(() =>
        withPolicy(shape as unknown as TransactionPartialSigner, { policy, loader: good }),
      ).toThrow(/UNSUPPORTED_INNER_SIGNER/);
    }
  });

  it('two calls at once do not share a review: the refused one stays refused', async () => {
    const inner = counting(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader: good, now });
    const [a, b] = await Promise.allSettled([
      wrapped.signTransactions([transferTransaction(w, 1_000_000n)]),
      wrapped.signTransactions([transferTransaction(w, 6_000_000n)]),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(inner.calls()).toBe(1);
  });

  it('account data from the RPC that is not what its owner would write never gets a signature', async () => {
    // A token-program-owned account with arbitrary bytes: review() must not answer "allow",
    // whether it reports a reason or throws.
    const transaction = transferTransaction(w, 1_000_000n);
    const messageBytes = new Uint8Array(transaction.messageBytes);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(w.mint, w.treasuryAta, w.vendorAta),
        fc.oneof(
          fc.uint8Array({ minLength: 165, maxLength: 165 }),
          fc.uint8Array({ minLength: 82, maxLength: 82 }),
          fc.uint8Array({ maxLength: 400 }),
        ),
        async (address, data) => {
          const snapshot = snapshotFor(w);
          const accounts = new Map(snapshot.accounts);
          accounts.set(address, {
            owner: TOKEN_PROGRAM_ADDRESS,
            lamports: 2_039_280n,
            data,
            executable: false,
          });
          const outcome = await review({
            messageBytes,
            policy,
            snapshot: { slot: 100n, accounts },
            now: now(),
          }).then(
            (decision) => decision.outcome,
            () => 'threw' as const,
          );
          // "allow" is only acceptable when the random bytes happen to describe the very same
          // account (same mint, owner and an initialized state), which fast-check will not hit.
          expect(outcome === 'deny' || outcome === 'threw').toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('x402 bound signer: the key is never called without a reservation', async () => {
  const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
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
  const quote = () => ({
    scheme: 'exact',
    network: DEVNET,
    amount: '20000',
    asset: mint,
    payTo: shop,
    maxTimeoutSeconds: 60,
    extra: { feePayer, transactionVersions: [0] },
  });
  function payment(signer: TransactionPartialSigner, nonce = 'a'.repeat(32)) {
    const transaction = compileTransaction(
      pipe(
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
                amount: 20_000n,
                decimals: 6,
              }),
              { programAddress: SPL_MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode(nonce) },
            ],
            m,
          ),
      ),
    );
    assertIsTransactionWithinSizeLimit(transaction);
    return transaction;
  }

  it('a ledger that refuses, throws or never answers: the key is not called', async () => {
    const failing: BudgetLedger[] = [
      {
        usage: () => ({ reservedLast24h: 0n, paymentsLastMinute: 0 }),
        reserve: () => Promise.reject(new Error('disk full')),
        reservations: () => Promise.resolve([]),
      },
      {
        usage: () => ({ reservedLast24h: 0n, paymentsLastMinute: 0 }),
        reserve: () => Promise.resolve([{ code: 'X402_BUDGET_EXCEEDED' as const }]),
        reservations: () => Promise.resolve([]),
      },
      {
        usage: () => {
          throw new Error('ledger corrupt');
        },
        reserve: () => Promise.resolve([]),
        reservations: () => Promise.resolve([]),
      },
    ];
    for (const ledger of failing) {
      const inner = counting(agent);
      const guard = createX402Guard({ inner: inner.signer, policy, loader, ledger, now });
      const bound = guard.signerFor(quote());
      await expect(bound.signTransactions([payment(bound)])).rejects.toThrow();
      expect(inner.calls()).toBe(0);
    }
    const inner = counting(agent);
    const never: BudgetLedger = {
      usage: () => ({ reservedLast24h: 0n, paymentsLastMinute: 0 }),
      reserve: () => new Promise(() => undefined),
      reservations: () => Promise.resolve([]),
    };
    const guard = createX402Guard({ inner: inner.signer, policy, loader, ledger: never, now });
    const bound = guard.signerFor(quote());
    expect(await within(bound.signTransactions([payment(bound)]), 150)).toBe('still pending');
    expect(inner.calls()).toBe(0);
  });

  it('a loader that throws: no reservation and no key call, and the signer is spent', async () => {
    const inner = counting(agent);
    const ledger = createMemoryLedger();
    const guard = createX402Guard({
      inner: inner.signer,
      policy,
      loader: { load: () => Promise.reject(new Error('RPC down')) },
      ledger,
      now,
    });
    const bound = guard.signerFor(quote());
    await expect(bound.signTransactions([payment(bound)])).rejects.toThrow('RPC down');
    await expect(bound.signTransactions([payment(bound)])).rejects.toThrow(
      /X402_SIGNER_ALREADY_USED/,
    );
    expect(inner.calls()).toBe(0);
    expect(await ledger.reservations()).toEqual([]);
  });

  it('a key that fails after the reservation: the reservation stays', async () => {
    const ledger = createMemoryLedger();
    const broken: TransactionPartialSigner = {
      address: agent.address,
      signTransactions: () => Promise.reject(new Error('HSM offline')),
    };
    const guard = createX402Guard({ inner: broken, policy, loader, ledger, now });
    const bound = guard.signerFor(quote());
    await expect(bound.signTransactions([payment(bound)])).rejects.toThrow('HSM offline');
    expect((await ledger.reservations()).map((r) => r.amount)).toEqual([20_000n]);
  });

  it('many bound signers at once never sign more than the budget allows', async () => {
    // The daily budget is 50,000; each payment is 20,000: two fit, whatever the interleaving.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 8 }), async (count) => {
        const inner = counting(agent);
        const ledger = createMemoryLedger();
        const guard = createX402Guard({ inner: inner.signer, policy, loader, ledger, now });
        const results = await Promise.allSettled(
          Array.from({ length: count }, (_, i) => {
            const bound = guard.signerFor(quote());
            return bound.signTransactions([payment(bound, i.toString(16).padStart(32, '0'))]);
          }),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        expect(inner.calls()).toBe(2);
        expect((await ledger.reservations()).length).toBe(2);
      }),
      { numRuns: 15 },
    );
  });
});
