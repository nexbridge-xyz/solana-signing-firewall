// The fixed cast of accounts every core vector uses. All keys come from fixed
// seeds, so the generator is deterministic. Names are fictional roles.
import { createHash } from 'node:crypto';

import {
  type Address,
  type KeyPairSigner,
  address,
  createKeyPairSignerFromPrivateKeyBytes,
} from '@solana/kit';
import { getAddressLookupTableEncoder } from '@solana-program/address-lookup-table';
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
} from '@solana-program/token';

import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS,
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

async function ata(owner: Address): Promise<Address> {
  const [found] = await findAssociatedTokenPda({
    mint: DEVNET_USDC_MINT,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return found;
}

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld() {
  const treasury = await fixtureSigner('treasury');
  const approver = await fixtureSigner('approver');
  const vendorA = (await fixtureSigner('vendor-a')).address;
  const vendorB = (await fixtureSigner('vendor-b')).address;
  const outsider = (await fixtureSigner('outsider')).address;
  return {
    treasury,
    approver,
    vendorA,
    vendorB,
    outsider,
    mint: DEVNET_USDC_MINT,
    mintAuthority: (await fixtureSigner('usdc-authority')).address,
    treasuryAta: await ata(treasury.address),
    vendorAAta: await ata(vendorA),
    vendorBAta: await ata(vendorB),
    outsiderAta: await ata(outsider),
    /** A USDC token account owned by the outsider that is not an associated token account. */
    outsiderPlainAccount: (await fixtureSigner('outsider-plain-token-account')).address,
    lookupTable: (await fixtureSigner('lookup-table')).address,
    nonceAccount: (await fixtureSigner('nonce-account')).address,
  };
}

/** Rent-exempt minimum under the current rent parameters (3480 lamports/byte-year, 2 years). */
function rentExempt(dataLength: number): bigint {
  return BigInt(dataLength + 128) * 6_960n;
}

export function mintAccount(world: World): SnapshotAccount {
  const data = new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: world.mintAuthority,
      supply: 1_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: world.mintAuthority,
    }),
  );
  return {
    owner: TOKEN_PROGRAM_ADDRESS,
    lamports: rentExempt(data.length),
    data,
    executable: false,
  };
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

export function lookupTableAccount(
  entries: readonly Address[],
  options: { lastExtendedSlot?: bigint; deactivationSlot?: bigint } = {},
): SnapshotAccount {
  const data = new Uint8Array(
    getAddressLookupTableEncoder().encode({
      deactivationSlot: options.deactivationSlot ?? 0xffff_ffff_ffff_ffffn,
      lastExtendedSlot: options.lastExtendedSlot ?? 900n,
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

/** The accounts every transfer vector needs: the mint and the four USDC accounts. */
export function baseAccounts(world: World): [Address, SnapshotAccount][] {
  return [
    [world.mint, mintAccount(world)],
    [world.treasuryAta, tokenAccount(world.mint, world.treasury.address, 50_000_000n)],
    [world.vendorAAta, tokenAccount(world.mint, world.vendorA, 0n)],
    [world.vendorBAta, tokenAccount(world.mint, world.vendorB, 0n)],
    [world.outsiderAta, tokenAccount(world.mint, world.outsider, 0n)],
  ];
}

export function payoutsPolicy(world: World) {
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
      [world.mint]: { decimals: 6, maxPerTransaction: '5000000', approvalAbove: '2000000' },
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
