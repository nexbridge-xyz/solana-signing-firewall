// Security review, guarantee G1 (and G4 for the bound signer): the inner signer is called only for
// the exact bytes review() allowed, and every returned signature is checked against those bytes.
//
// The caller of signTransactions() is the party the wrapper constrains: application code, or the
// x402 SDK. It keeps a reference to the transaction objects it passes in, and the wrapper awaits
// (snapshot load, review, approval lookup, budget reservation) before it calls the key. Whatever the
// caller does to those objects during that time must not change what is signed.
import { describe, expect, it } from 'vitest';
import {
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getPublicKeyFromAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  verifySignature,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token';

import {
  PolicyViolationError,
  SPL_MEMO_PROGRAM_ADDRESS,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  createMemoryLedger,
  createX402Guard,
  parsePolicy,
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

/** Records the exact bytes the key was asked to sign. */
function recording(inner: KeyPairSigner) {
  const signed: Uint8Array[] = [];
  const signer: TransactionPartialSigner = {
    address: inner.address,
    signTransactions(transactions, config) {
      for (const tx of transactions) signed.push(new Uint8Array(tx.messageBytes));
      return inner.signTransactions(transactions, config);
    },
  };
  return { signer, signed };
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

async function validOver(
  signer: Address,
  signature: SignatureBytes | undefined,
  bytes: Uint8Array,
) {
  if (signature === undefined) return false;
  return verifySignature(await getPublicKeyFromAddress(signer), signature, bytes);
}

/** Resolves to the signatures, or to the refusal. Either is acceptable; signing other bytes is not. */
async function settle<T>(promise: Promise<T>): Promise<T | PolicyViolationError> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof PolicyViolationError) return error;
    throw error;
  }
}

// ------------------------------------------------------------------ withPolicy()

describe('withPolicy(): the bytes that are signed are the bytes that were reviewed', async () => {
  const w = await testWorld();
  const policy = policyFor(w);
  const loader = staticSnapshotLoader(snapshotFor(w));
  // 1.00 USDC passes; 6.00 USDC is over the 5.00 cap and review() denies it.
  const allowedBytes = () => new Uint8Array(transferTransaction(w, 1_000_000n).messageBytes);
  const deniedTransaction = () => transferTransaction(w, 6_000_000n);

  it('a caller that overwrites messageBytes in place after the call starts gets nothing signed over them', async () => {
    const inner = recording(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const transaction = transferTransaction(w, 1_000_000n);
    const denied = new Uint8Array(deniedTransaction().messageBytes);
    expect(denied.length).toBe(transaction.messageBytes.length);

    const pending = settle(wrapped.signTransactions([transaction]));
    (transaction.messageBytes as unknown as Uint8Array).set(denied); // the review has only begun
    const result = await pending;

    for (const bytes of inner.signed) expect(same(bytes, denied)).toBe(false);
    if (!(result instanceof PolicyViolationError)) {
      const signature = result[0]?.[w.treasury.address];
      expect(await validOver(w.treasury.address, signature, denied)).toBe(false);
      expect(await validOver(w.treasury.address, signature, allowedBytes())).toBe(true);
    }
  });

  it('a caller that swaps the array element after the call starts gets nothing signed for the new one', async () => {
    const inner = recording(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const denied = deniedTransaction();
    const list: Transaction[] = [transferTransaction(w, 1_000_000n)];

    const pending = settle(wrapped.signTransactions(list as never));
    list[0] = denied;
    const result = await pending;

    const deniedBytes = new Uint8Array(denied.messageBytes);
    for (const bytes of inner.signed) expect(same(bytes, deniedBytes)).toBe(false);
    if (!(result instanceof PolicyViolationError)) {
      expect(
        await validOver(w.treasury.address, result[0]?.[w.treasury.address], deniedBytes),
      ).toBe(false);
    }
  });

  it('a transaction object that answers differently on each read is signed as first read, or not at all', async () => {
    const inner = recording(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const allowed = transferTransaction(w, 1_000_000n);
    const denied = deniedTransaction();
    let reads = 0;
    const shifty = {
      get messageBytes() {
        reads += 1;
        return reads === 1 ? allowed.messageBytes : denied.messageBytes;
      },
      signatures: allowed.signatures,
    } as unknown as Transaction;

    const result = await settle(wrapped.signTransactions([shifty] as never));

    const deniedBytes = new Uint8Array(denied.messageBytes);
    for (const bytes of inner.signed) expect(same(bytes, deniedBytes)).toBe(false);
    if (!(result instanceof PolicyViolationError)) {
      expect(
        await validOver(w.treasury.address, result[0]?.[w.treasury.address], deniedBytes),
      ).toBe(false);
    }
  });

  it('an inner signer that rewrites the bytes it is handed, and signs the rewrite, is refused', async () => {
    // What a "modify and sign" backend does (a new blockhash, a new fee payer), here hidden
    // behind signTransactions(): it edits the buffer in place and signs the result.
    const rewritten: Uint8Array[] = [];
    const rewriting: TransactionPartialSigner = {
      address: w.treasury.address,
      async signTransactions(transactions) {
        return Promise.all(
          transactions.map(async (tx) => {
            const bytes = tx.messageBytes as unknown as Uint8Array;
            bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
            rewritten.push(new Uint8Array(bytes));
            return {
              [w.treasury.address]: await signBytes(w.treasury.keyPair.privateKey, bytes),
            };
          }),
        );
      },
    };
    const wrapped = withPolicy(rewriting, { policy, loader, now });
    const transaction = transferTransaction(w, 1_000_000n);
    const reviewed = new Uint8Array(transaction.messageBytes);

    const result = await settle(wrapped.signTransactions([transaction]));

    expect(rewritten).toHaveLength(1);
    expect(result).toBeInstanceOf(PolicyViolationError);
    expect((result as PolicyViolationError).reasons.map((r) => r.code)).toEqual([
      'SIGNATURE_INVALID',
    ]);
    // The caller's transaction still holds the bytes that were reviewed.
    expect(same(new Uint8Array(transaction.messageBytes), reviewed)).toBe(true);
  });
});

// ------------------------------------------------------------------ the x402 bound signer

describe('x402 bound signer: the bytes that are signed are the bytes that were bound to the quote', async () => {
  const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const agent = await generateKeyPairSigner();
  const shop = (await generateKeyPairSigner()).address;
  const thief = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const mint = (await generateKeyPairSigner()).address;
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const agentAta = await ata(agent.address);
  const shopAta = await ata(shop);
  const thiefAta = await ata(thief);

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
      [thiefAta, owned(tokenData(mint, thief, 0n))],
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

  /** The SDK's version-0 layout. `destination` and `amount` are what a replaced SDK would change. */
  function payment(signer: TransactionPartialSigner, destination: Address, amount: bigint) {
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
                destination,
                authority: signer,
                amount,
                decimals: 6,
              }),
              {
                programAddress: SPL_MEMO_PROGRAM_ADDRESS,
                data: new TextEncoder().encode('a'.repeat(32)),
              },
            ],
            m,
          ),
      ),
    );
    assertIsTransactionWithinSizeLimit(transaction);
    return transaction;
  }

  function guardWith(inner: TransactionPartialSigner) {
    const ledger = createMemoryLedger();
    return { ledger, guard: createX402Guard({ inner, policy, loader, ledger, now }) };
  }

  it('an SDK that overwrites the payment in place after asking for the signature gets nothing signed over it', async () => {
    const inner = recording(agent);
    const { guard } = guardWith(inner.signer);
    const bound = guard.signerFor(quote());
    const honest = payment(bound, shopAta, 20_000n);
    // The whole balance, to an account the policy does not list.
    const theft = new Uint8Array(payment(bound, thiefAta, 1_000_000n).messageBytes);
    expect(theft.length).toBe(honest.messageBytes.length);

    const pending = settle(bound.signTransactions([honest]));
    (honest.messageBytes as unknown as Uint8Array).set(theft);
    const result = await pending;

    for (const bytes of inner.signed) expect(same(bytes, theft)).toBe(false);
    if (!(result instanceof PolicyViolationError)) {
      expect(await validOver(agent.address, result[0]?.[agent.address], theft)).toBe(false);
    }
  });

  it('an SDK that appends a second transaction after the length check gets it neither signed nor returned', async () => {
    const inner = recording(agent);
    const { guard, ledger } = guardWith(inner.signer);
    const bound = guard.signerFor(quote());
    const theft = payment(bound, thiefAta, 1_000_000n);
    const list: Transaction[] = [payment(bound, shopAta, 20_000n)];

    const pending = settle(bound.signTransactions(list as never));
    list.push(theft);
    const result = await pending;

    const theftBytes = new Uint8Array(theft.messageBytes);
    for (const bytes of inner.signed) expect(same(bytes, theftBytes)).toBe(false);
    if (!(result instanceof PolicyViolationError)) expect(result).toHaveLength(1);
    // One payment at most was reserved, whatever was asked for.
    expect((await ledger.reservations()).length).toBeLessThanOrEqual(1);
  });

  it('a quote object changed after signerFor() does not change what the signer is bound to', async () => {
    const inner = recording(agent);
    const { guard } = guardWith(inner.signer);
    const requirements = quote();
    const bound = guard.signerFor(requirements);
    // After binding, whoever holds the object halves the amount; the bytes follow the new amount.
    requirements.amount = '10000';
    const result = await settle(bound.signTransactions([payment(bound, shopAta, 10_000n)]));

    expect(result).toBeInstanceOf(PolicyViolationError);
    expect((result as PolicyViolationError).reasons.map((r) => r.code)).toEqual([
      'X402_AMOUNT_MISMATCH',
    ]);
    expect(inner.signed).toHaveLength(0);
  });
});
