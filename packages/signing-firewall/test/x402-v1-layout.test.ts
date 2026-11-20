// The accepted version-1 layout sets both the compute-unit limit and the loaded-accounts data size
// in its transactionConfig (docs/X402.md, "Layout"). The guard refuses a payment without the
// limit even when the policy does not require an explicit limit for other transactions.
import { describe, expect, it } from 'vitest';
import {
  type Address,
  type TransactionPartialSigner,
  type V1TransactionConfig,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
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
const now = new Date('2026-11-20T00:00:00.000Z');

const agent = await generateKeyPairSigner();
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const mint = (await generateKeyPairSigner()).address;
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const agentAta = await ata(agent.address);
const shopAta = await ata(shop);

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

const policy = parsePolicy({
  schema: 'solana-signing-firewall.policy/v0',
  policyId: 'agent',
  network: 'localnet',
  signer: agent.address,
  feePayers: [feePayer],
  messageVersions: ['v1'],
  mints: { [mint]: { decimals: 6, maxPerTransaction: '20000' } },
  sources: [agentAta],
  recipients: { owners: [shop] },
  // Not required for other transactions: only the x402 layout requires the limit.
  fees: {
    maxComputeUnitLimit: 200000,
    maxPriorityFeeLamports: '50000',
    requireExplicitComputeUnitLimit: false,
  },
  memo: { allowed: true, maxBytes: 256 },
  x402: {
    networks: [DEVNET],
    maxTimeoutSeconds: 120,
    maxComputeUnitPriceMicroLamports: '5000000',
    budgets: { [mint]: { maxPerDay: '50000' } },
    maxPaymentsPerMinute: 10,
  },
});

const quote = {
  scheme: 'exact',
  network: DEVNET,
  amount: '20000',
  asset: mint,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra: { feePayer, transactionVersions: [1] },
};

function payment(authority: TransactionPartialSigner, config: V1TransactionConfig) {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
          m,
        ),
      (m) => setTransactionMessageConfig(config, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source: agentAta,
              mint,
              destination: shopAta,
              authority,
              amount: 20_000n,
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

function bound() {
  const calls: number[] = [];
  const inner: TransactionPartialSigner = {
    address: agent.address,
    signTransactions(transactions, config) {
      calls.push(transactions.length);
      return agent.signTransactions(transactions, config);
    },
  };
  const guard = createX402Guard({
    inner,
    policy,
    loader,
    ledger: createMemoryLedger(),
    now: () => now,
  });
  return { signer: guard.signerFor(quote), calls };
}

describe('the version-1 payment layout', () => {
  it('signs a payment that sets the limit and the data size (control)', async () => {
    const { signer, calls } = bound();
    await signer.signTransactions([
      payment(signer, {
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports: 1n,
      }),
    ]);
    expect(calls).toEqual([1]);
  });

  it('refuses a payment without a compute-unit limit, though the policy does not require one', async () => {
    const { signer, calls } = bound();
    const refusal = await signer
      .signTransactions([
        // No priority fee, so the price cap has nothing to refuse: only the layout check does.
        payment(signer, { loadedAccountsDataSizeLimit: 4_194_304, priorityFeeLamports: 0n }),
      ])
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(PolicyViolationError);
    expect((refusal as PolicyViolationError).reasons.map((r) => r.code)).toEqual([
      'X402_LAYOUT_INVALID',
    ]);
    expect(calls).toEqual([]);
  });
});
