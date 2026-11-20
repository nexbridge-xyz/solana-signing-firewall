// The fixed cast of accounts every core vector uses. All keys come from fixed
// seeds, so the generator is deterministic. Names are fictional roles. These
// keys are public by construction: never fund them on a network.
import { createHash } from 'node:crypto';

import {
  type Address,
  type KeyPairSigner,
  address,
  createKeyPairSignerFromPrivateKeyBytes,
} from '@solana/kit';
import { getAddressLookupTableEncoder } from '@solana-program/address-lookup-table';
import { NonceState, NonceVersion, getNonceEncoder } from '@solana-program/system';
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
} from '@solana-program/token';

import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
} from '@nexbridge/solana-signing-firewall';

const SEED_DOMAIN = 'solana-signing-firewall/fixtures/v0/';

/** Circle's devnet USDC mint (SPL Token, 6 decimals), so vectors match the devnet demo. */
export const DEVNET_USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export async function fixtureSigner(label: string): Promise<KeyPairSigner> {
  const seed = createHash('sha256')
    .update(SEED_DOMAIN + label)
    .digest();
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
}

async function ata(owner: Address, mint: Address): Promise<Address> {
  const [found] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return found;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld() {
  const treasury = await fixtureSigner('treasury');
  const approver = await fixtureSigner('approver');
  const vendorA = await fixtureSigner('vendor-a');
  const vendorB = await fixtureSigner('vendor-b');
  const outsider = await fixtureSigner('outsider');
  const sponsor = await fixtureSigner('fee-sponsor');
  const otherMint = (await fixtureSigner('other-token-mint')).address;
  const signers = new Map<Address, KeyPairSigner>(
    [treasury, approver, vendorA, vendorB, outsider, sponsor].map((s) => [s.address, s]),
  );
  return {
    treasury,
    approver,
    vendorA: vendorA.address,
    vendorB: vendorB.address,
    outsider,
    sponsor,
    signers,
    mint: DEVNET_USDC_MINT,
    otherMint,
    mintAuthority: (await fixtureSigner('usdc-authority')).address,
    treasuryAta: await ata(treasury.address, DEVNET_USDC_MINT),
    vendorAAta: await ata(vendorA.address, DEVNET_USDC_MINT),
    vendorBAta: await ata(vendorB.address, DEVNET_USDC_MINT),
    outsiderAta: await ata(outsider.address, DEVNET_USDC_MINT),
    treasuryOtherAta: await ata(treasury.address, otherMint),
    vendorAOtherAta: await ata(vendorA.address, otherMint),
    /** A USDC token account owned by the outsider that is not an associated token account. */
    outsiderPlainAccount: (await fixtureSigner('outsider-plain-token-account')).address,
    lookupTable: (await fixtureSigner('lookup-table')).address,
    nonceAccount: (await fixtureSigner('nonce-account')).address,
    /** Stands in for an offline-signer program. Not the address of any real program. */
    placeholderProgram: (await fixtureSigner('placeholder-offline-signer-program')).address,
  };
}

/** Rent-exempt minimum under the current rent parameters (3480 lamports/byte-year, 2 years). */
export function rentExempt(dataLength: number): bigint {
  return BigInt(dataLength + 128) * 6_960n;
}

export function mintAccount(
  world: World,
  decimals = 6,
  owner: Address = TOKEN_PROGRAM_ADDRESS,
): SnapshotAccount {
  const data = new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: world.mintAuthority,
      supply: 1_000_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: world.mintAuthority,
    }),
  );
  return { owner, lamports: rentExempt(data.length), data, executable: false };
}

export function tokenAccount(
  mint: Address,
  owner: Address,
  amount: bigint,
  state: AccountState = AccountState.Initialized,
): SnapshotAccount {
  const data = new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );
  return {
    owner: TOKEN_PROGRAM_ADDRESS,
    lamports: rentExempt(data.length),
    data,
    executable: false,
  };
}

export function lookupTableAccount(entries: readonly Address[]): SnapshotAccount {
  const data = new Uint8Array(
    getAddressLookupTableEncoder().encode({
      deactivationSlot: 0xffff_ffff_ffff_ffffn,
      lastExtendedSlot: 900n,
      lastExtendedSlotStartIndex: 0,
      authority: null,
      addresses: [...entries],
    }),
  );
  return {
    owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
    lamports: rentExempt(data.length),
    data,
    executable: false,
  };
}

export function nonceAccount(authority: Address, nonce: string): SnapshotAccount {
  const data = new Uint8Array(
    getNonceEncoder().encode({
      version: NonceVersion.Current,
      state: NonceState.Initialized,
      authority,
      blockhash: address(nonce),
      lamportsPerSignature: 5_000n,
    }),
  );
  return {
    owner: SYSTEM_PROGRAM_ADDRESS,
    lamports: rentExempt(data.length),
    data,
    executable: false,
  };
}

/** The accounts every transfer vector needs: the mint and the four USDC accounts. */
export function baseAccounts(world: World): [Address, SnapshotAccount | null][] {
  return [
    [world.mint, mintAccount(world)],
    [world.treasuryAta, tokenAccount(world.mint, world.treasury.address, 50_000_000n)],
    [world.vendorAAta, tokenAccount(world.mint, world.vendorA, 0n)],
    [world.vendorBAta, tokenAccount(world.mint, world.vendorB, 0n)],
    [world.outsiderAta, tokenAccount(world.mint, world.outsider.address, 0n)],
  ];
}

export type PolicyName = 'payouts' | 'payouts-no-batch' | 'payouts-no-v1' | 'payouts-sponsored';

export const POLICY_FILES: Record<PolicyName, string> = {
  payouts: 'policies/fixtures-payouts.json',
  'payouts-no-batch': 'policies/fixtures-payouts-no-batch.json',
  'payouts-no-v1': 'policies/fixtures-payouts-no-v1.json',
  'payouts-sponsored': 'policies/fixtures-payouts-sponsored.json',
};

export function payoutsPolicy(world: World, approvalAbove = '2000000') {
  return {
    schema: 'solana-signing-firewall.policy/v0',
    policyId: 'fixtures-payouts',
    network: 'devnet',
    signer: world.treasury.address,
    feePayers: [world.treasury.address],
    messageVersions: ['legacy', 'v0', 'v1'],
    durableNonce: 'deny',
    tokenBatch: 'transfers-only',
    mints: {
      [world.mint]: { decimals: 6, maxPerTransaction: '5000000', approvalAbove },
    },
    sources: [world.treasuryAta],
    recipients: { owners: [world.vendorA, world.vendorB], requireAssociatedTokenAccount: true },
    fees: {
      maxComputeUnitLimit: 200000,
      maxPriorityFeeLamports: '50000',
      requireExplicitComputeUnitLimit: true,
    },
    memo: { allowed: true, maxBytes: 64 },
    approval: { approvers: [world.approver.address], ttlSeconds: 90 },
  };
}

export function policyJson(world: World, name: PolicyName) {
  const base = payoutsPolicy(world);
  switch (name) {
    case 'payouts':
      return base;
    case 'payouts-no-batch':
      return { ...base, policyId: 'fixtures-payouts-no-batch', tokenBatch: 'deny' };
    case 'payouts-no-v1':
      return { ...base, policyId: 'fixtures-payouts-no-v1', messageVersions: ['legacy', 'v0'] };
    case 'payouts-sponsored':
      return {
        ...base,
        policyId: 'fixtures-payouts-sponsored',
        feePayers: [world.treasury.address, world.sponsor.address],
      };
  }
}
