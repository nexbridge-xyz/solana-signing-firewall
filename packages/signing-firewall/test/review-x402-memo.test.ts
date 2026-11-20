// Security review: a documented limit of the x402 guard, shown with the bound signer.
//
// The guard lets the agent's key sign a Memo only in two forms: 32 lower-case hex characters, or
// exactly the text of the quote's `extra.memo`. The second form is chosen by whoever supplies the
// quote. That is the seller; and, because the guard receives the quote from the payment SDK, it
// is also a replaced or faulty SDK, which can add an `extra.memo` of its own to any quote.
// Either can therefore make the key sign up to 256 bytes of text of its choosing in each payment
// (less if the policy's `memo.maxBytes` is lower), not the 16 bytes of the hex nonce.
import { describe, expect, it } from 'vitest';
import {
  type Address,
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
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';
import { mintData, tokenData } from './world.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const now = () => new Date('2026-11-20T00:00:00.000Z');
const agent = await generateKeyPairSigner();
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const mint = (await generateKeyPairSigner()).address;
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const agentAta = await ata(agent.address);
const shopAta = await ata(shop);

const policyWith = (memoMaxBytes: number) =>
  parsePolicy({
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
    memo: { allowed: true, maxBytes: memoMaxBytes },
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
const quote = (memo?: string) => ({
  scheme: 'exact',
  network: DEVNET,
  amount: '20000',
  asset: mint,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra: { feePayer, transactionVersions: [0], ...(memo === undefined ? {} : { memo }) },
});
function payment(signer: TransactionPartialSigner, memo: string) {
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
            { programAddress: SPL_MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode(memo) },
          ],
          m,
        ),
    ),
  );
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

/** Signs `memo` through a guard bound to `requirements`; true when the key signed those bytes. */
async function signs(requirements: unknown, memo: string, memoMaxBytes = 256) {
  const guard = createX402Guard({
    inner: agent,
    policy: policyWith(memoMaxBytes),
    loader,
    ledger: createMemoryLedger(),
    now,
  });
  const bound = guard.signerFor(requirements);
  const transaction = payment(bound, memo);
  try {
    const [signatures] = await bound.signTransactions([transaction]);
    const signature = signatures?.[agent.address];
    if (signature === undefined) return false;
    return await verifySignature(
      await getPublicKeyFromAddress(agent.address),
      signature,
      new Uint8Array(transaction.messageBytes),
    );
  } catch (error) {
    if (error instanceof PolicyViolationError) return error.reasons.map((r) => r.code);
    throw error;
  }
}

describe('what the agent key signs as a Memo', () => {
  it('without extra.memo: only 32 lower-case hex characters (holds)', async () => {
    expect(await signs(quote(), 'a'.repeat(32))).toBe(true);
    expect(await signs(quote(), 'I owe the shop 1,000 USDC')).toEqual(['X402_MEMO_MISMATCH']);
    expect(await signs(quote(), 'A'.repeat(32))).toEqual(['X402_MEMO_MISMATCH']);
    expect(await signs(quote(), 'a'.repeat(64))).toEqual(['X402_MEMO_MISMATCH']);
  });

  it('with extra.memo: any text the seller chose, statements included', async () => {
    const statement =
      'I, the holder of this key, approve the transfer of all my funds to the bearer of this memo.';
    expect(await signs(quote(statement), statement)).toBe(true);
  });

  it('with extra.memo: control characters and invisible or direction-changing Unicode', async () => {
    const control = 'line one\nline two\u0000\u0007\u001b[2J';
    const invisible = 'pay​‍⁠ment ‮etacovda‬ ﻿end';
    expect(await signs(quote(control), control)).toBe(true);
    expect(await signs(quote(invisible), invisible)).toBe(true);
  });

  it('with extra.memo: 256 bytes per payment, sixteen times the 16 bytes of a nonce', async () => {
    const full = 'x'.repeat(256);
    expect(await signs(quote(full), full)).toBe(true);
    expect(await signs(quote('x'.repeat(257)), 'x'.repeat(257))).toContain(
      'X402_REQUIREMENTS_MALFORMED',
    );
  });

  it('a replaced SDK adds its own extra.memo to a quote that had none, and the key signs it', async () => {
    const fromSeller = quote();
    // The SDK hands the guard the quote; nothing ties that object to what the seller sent.
    const stolen = 'stolen: ' + 'd'.repeat(248);
    const altered = { ...fromSeller, extra: { ...fromSeller.extra, memo: stolen } };
    expect(await signs(altered, stolen)).toBe(true);
  });

  it("the policy's memo.maxBytes is the only bound an operator can set on it", async () => {
    const text = 'y'.repeat(100);
    expect(await signs(quote(text), text, 100)).toBe(true);
    expect(await signs(quote(text), text, 32)).toEqual(['MEMO_NOT_ALLOWED']);
    // 32 still lets the SDK's own hex nonce through.
    expect(await signs(quote(), 'a'.repeat(32), 32)).toBe(true);
  });
});
