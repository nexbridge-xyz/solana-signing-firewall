// The source of an x402 payment and the facilitator's fee payers.
//
// The spec, section 2.1.3: "The sponsor MUST reject any transaction in which the sponsor's funds
// could be debited beyond the network fee — including SOL transfers from sponsor-controlled
// accounts, token transfers for which the sponsor is the authority, or account closures/
// reallocations that move the sponsor's lamports." Section 2.1.1: "The `feePayer` MUST NOT be used
// as an authority, source, or delegate for any transfer."
//
// What we check, in the guard and in the verifier: the source of the transfer is the associated
// token account of its authority (the payer) for the transferred mint, and no fee payer the
// verifier config or the policy lists appears in any instruction.
import { describe, expect, it } from 'vitest';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionPartialSigner,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  AccountState,
  findAssociatedTokenPda,
  getTokenEncoder,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import {
  PolicyViolationError,
  SPL_MEMO_PROGRAM_ADDRESS,
  type Snapshot,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  createMemoryLedger,
  createX402Guard,
  parsePolicy,
  parseVerifierConfig,
  staticSnapshotLoader,
  verifyX402Payment,
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';
import { mintData } from './world.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const now = new Date('2026-11-20T00:00:00.000Z');
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 0n };

const agent = await generateKeyPairSigner();
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const secondFeePayer = await generateKeyPairSigner();
const mint = (await generateKeyPairSigner()).address;
const ata = async (owner: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const agentAta = await ata(agent.address);
const shopAta = await ata(shop);
const feePayerAta = await ata(feePayer);
const secondFeePayerAta = await ata(secondFeePayer.address);
/** A token account the agent owns at an address that is not its associated token account. */
const agentOther = (await generateKeyPairSigner()).address;

function token(
  owner: Address,
  amount: bigint,
  delegate?: { readonly address: Address; readonly amount: bigint },
): SnapshotAccount {
  const data = new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: delegate === undefined ? null : delegate.address,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: delegate === undefined ? 0n : delegate.amount,
      closeAuthority: null,
    }),
  );
  return { owner: TOKEN_PROGRAM_ADDRESS, lamports: 2_039_280n, data, executable: false };
}

const delegation = { address: agent.address, amount: 20_000n };
function snapshot(): Snapshot {
  return {
    slot: 1n,
    accounts: new Map<Address, SnapshotAccount | null>([
      [
        mint,
        { owner: TOKEN_PROGRAM_ADDRESS, lamports: 1_461_600n, data: mintData(), executable: false },
      ],
      [agentAta, token(agent.address, 1_000_000n)],
      [agentOther, token(agent.address, 1_000_000n)],
      // The payee's own account, which names the agent as its delegate.
      [shopAta, token(shop, 20_000n, delegation)],
      // The fee payer's own account, which names the agent as its delegate.
      [feePayerAta, token(feePayer, 1_000_000n, delegation)],
      [secondFeePayerAta, token(secondFeePayer.address, 1_000_000n)],
    ]),
  };
}

const quote = () => ({
  scheme: 'exact',
  network: DEVNET,
  amount: '20000',
  asset: mint,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra: { feePayer, transactionVersions: [0] },
});

function instructions(source: Address, authority: TransactionSigner): Instruction[] {
  return [
    getSetComputeUnitLimitInstruction({ units: 20_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 1n }),
    getTransferCheckedInstruction({
      source,
      mint,
      destination: shopAta,
      authority,
      amount: 20_000n,
      decimals: 6,
    }),
    { programAddress: SPL_MEMO_PROGRAM_ADDRESS, data: new TextEncoder().encode('a'.repeat(32)) },
  ];
}

const message = (source: Address, authority: TransactionSigner) =>
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    (m) => appendTransactionMessageInstructions(instructions(source, authority), m),
  );

/** A payment as the SDK hands it to the bound signer: compiled, not signed yet. */
function compiled(source: Address, authority: TransactionSigner) {
  const transaction = compileTransaction(message(source, authority));
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

/** A payment as the buyer sends it to a facilitator: signed by the transfer authority. */
async function signedPayment(source: Address, authority: KeyPairSigner): Promise<string> {
  return getBase64EncodedWireTransaction(
    await partiallySignTransactionMessageWithSigners(message(source, authority)),
  );
}

const configJson = {
  schema: 'solana-signing-firewall.x402-verifier/v0',
  networks: [DEVNET],
  feePayers: [feePayer, secondFeePayer.address],
  messageVersions: ['v0', 'v1'],
  assets: { [mint]: { decimals: 6 } },
  maxComputeUnitLimit: 200000,
  maxComputeUnitPriceMicroLamports: '5000000',
  maxPriorityFeeLamports: '100000',
  maxRequiredSignatures: 2,
};

async function verifierCodes(transaction: string) {
  const decision = await verifyX402Payment({
    transaction,
    requirements: quote(),
    config: parseVerifierConfig(configJson),
    snapshot: snapshot(),
    now,
  });
  return decision.reasons.map((r) => [r.code, r.account]);
}

describe('the verifier and the source of a payment', () => {
  it("accepts a payment from the payer's associated token account (control)", async () => {
    expect(await verifierCodes(await signedPayment(agentAta, agent))).toEqual([]);
  });

  it("refuses a payment whose source is the payee's own account, with the payer as its delegate", async () => {
    // The source and the destination are the same account: the payee receives nothing.
    expect(await verifierCodes(await signedPayment(shopAta, agent))).toEqual([
      ['X402_SOURCE_NOT_PAYER_ATA', shopAta],
    ]);
  });

  it("refuses a payment from the fee payer's token account, with the payer as its delegate", async () => {
    expect(await verifierCodes(await signedPayment(feePayerAta, agent))).toEqual([
      ['X402_SOURCE_NOT_PAYER_ATA', feePayerAta],
    ]);
  });

  it('refuses a payment whose authority is another fee payer of its config', async () => {
    // Signed by that fee payer: only fee payer isolation can refuse it.
    expect(await verifierCodes(await signedPayment(secondFeePayerAta, secondFeePayer))).toEqual([
      ['X402_FEE_PAYER_IN_INSTRUCTION', secondFeePayer.address],
    ]);
  });
});

describe('the guard and the source of a payment', () => {
  const policy = parsePolicy({
    schema: 'solana-signing-firewall.policy/v0',
    policyId: 'agent',
    network: 'localnet',
    signer: agent.address,
    feePayers: [feePayer],
    messageVersions: ['v0', 'v1'],
    mints: { [mint]: { decimals: 6, maxPerTransaction: '20000' } },
    // Both accounts are the agent's own, and the policy lists both.
    sources: [agentAta, agentOther],
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

  function guarded() {
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
      loader: staticSnapshotLoader(snapshot()),
      ledger: createMemoryLedger(),
      now: () => now,
    });
    return { guard, calls };
  }

  it("signs a payment from the agent's associated token account (control)", async () => {
    const { guard, calls } = guarded();
    const bound = guard.signerFor(quote());
    await bound.signTransactions([compiled(agentAta, bound)]);
    expect(calls).toEqual([1]);
  });

  it('refuses a payment from another token account of the agent, although the policy lists it', async () => {
    const { guard, calls } = guarded();
    const bound = guard.signerFor(quote());
    const refusal = await bound.signTransactions([compiled(agentOther, bound)]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PolicyViolationError);
    expect((refusal as PolicyViolationError).reasons.map((r) => [r.code, r.account])).toEqual([
      ['X402_SOURCE_NOT_PAYER_ATA', agentOther],
    ]);
    expect(calls).toEqual([]);
  });
});
