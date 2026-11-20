import {
  type Address,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import {
  type Policy,
  type Snapshot,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  parsePolicy,
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';

export type TestWorld = Awaited<ReturnType<typeof testWorld>>;

export async function testWorld() {
  const treasury = await generateKeyPairSigner();
  const approver = await generateKeyPairSigner();
  const vendor = await generateKeyPairSigner();
  const outsider = await generateKeyPairSigner();
  const mint = (await generateKeyPairSigner()).address;
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  return {
    treasury,
    approver,
    vendor,
    outsider,
    mint,
    treasuryAta: await ata(treasury.address),
    vendorAta: await ata(vendor.address),
  };
}

export function policyJson(w: TestWorld, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'solana-signing-firewall.policy/v0',
    policyId: 'test',
    network: 'localnet',
    signer: w.treasury.address,
    feePayers: [w.treasury.address],
    messageVersions: ['legacy', 'v0', 'v1'],
    tokenBatch: 'transfers-only',
    mints: { [w.mint]: { decimals: 6, maxPerTransaction: '5000000', approvalAbove: '2000000' } },
    sources: [w.treasuryAta],
    recipients: { owners: [w.vendor.address] },
    fees: { maxComputeUnitLimit: 200000, maxPriorityFeeLamports: '50000' },
    approval: { approvers: [w.approver.address], ttlSeconds: 90 },
    ...overrides,
  };
}

export const policyFor = (w: TestWorld, overrides: Record<string, unknown> = {}): Policy =>
  parsePolicy(policyJson(w, overrides));

export function mintData(decimals = 6): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
  );
}

export function tokenData(mint: Address, owner: Address, amount: bigint): Uint8Array {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );
}

const tokenOwned = (data: Uint8Array): SnapshotAccount => ({
  owner: TOKEN_PROGRAM_ADDRESS,
  lamports: 2_039_280n,
  data,
  executable: false,
});

export function snapshotFor(w: TestWorld): Snapshot {
  return {
    slot: 100n,
    accounts: new Map<Address, SnapshotAccount | null>([
      [w.mint, tokenOwned(mintData())],
      [w.treasuryAta, tokenOwned(tokenData(w.mint, w.treasury.address, 50_000_000n))],
      [w.vendorAta, tokenOwned(tokenData(w.mint, w.vendor.address, 0n))],
    ]),
  };
}

/** A legacy transfer from the treasury, ready to hand to a signer. */
export function transferTransaction(
  w: TestWorld,
  amount: bigint,
  feePayer: KeyPairSigner = w.treasury,
) {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 30_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
          getTransferCheckedInstruction({
            source: w.treasuryAta,
            mint: w.mint,
            destination: w.vendorAta,
            authority: w.treasury,
            amount,
            decimals: 6,
          }),
        ],
        m,
      ),
  );
  const transaction = compileTransaction(message);
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}
