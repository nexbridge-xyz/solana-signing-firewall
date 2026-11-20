// The demo's fictional cast and the addresses derived from their keys.
import {
  type Address,
  type KeyPairSigner,
  address,
  createAddressWithSeed,
  createSignerFromKeyPair,
  getAddressFromPublicKey,
} from '@solana/kit';
import { createKeychainSigner } from '@solana/keychain';
import { findAssociatedTokenPda } from '@solana-program/token';

import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@nexbridge/solana-signing-firewall';

import { ROLES, type Role } from './env.js';

/**
 * Fictional names, checked for existing use on 2026-11-20 (docs/DECISIONS.md D28).
 * They name no real company, and none of them is from the Arbitrum demo.
 */
export const NAMES: Record<Role, string> = {
  treasury: 'Orrin & Vale (treasury)',
  approver: 'Orrin & Vale (finance approver)',
  vendorA: 'Thistledown Print (vendor A)',
  vendorB: 'Cobbleway Freight (vendor B)',
  outsider: 'an unknown address (outsider)',
  agent: 'Orrin & Vale research agent',
  shop: 'Lantern Row (report shop)',
  facilitatorFeePayer: 'local facilitator fee payer',
};

export const SIGNER_LABEL = 'Solana Keychain (memory backend), wrapped by Signing Firewall';

/**
 * Circle's devnet USDC mint (SPL Token, 6 decimals). Setup checks the mint on
 * chain, and a test checks this value against the x402 SDK's devnet default.
 */
export const DEVNET_USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

/** Seeds for the two accounts derived from the treasury address. */
export const PLAIN_ACCOUNT_SEED = 'plain-usdc';
export const NONCE_ACCOUNT_SEED = 'durable-nonce';

export async function createCast(keys: Record<Role, CryptoKeyPair>, mint: Address) {
  const addresses = Object.fromEntries(
    await Promise.all(
      ROLES.map(async (role) => [role, await getAddressFromPublicKey(keys[role].publicKey)]),
    ),
  ) as Record<Role, Address>;
  const ata = async (owner: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  return {
    keys,
    mint,
    ...addresses,
    treasuryAta: await ata(addresses.treasury),
    vendorAAta: await ata(addresses.vendorA),
    vendorBAta: await ata(addresses.vendorB),
    outsiderAta: await ata(addresses.outsider),
    agentAta: await ata(addresses.agent),
    shopAta: await ata(addresses.shop),
    /** A USDC token account the outsider owns that is not an associated token account. */
    outsiderPlainAccount: await createAddressWithSeed({
      baseAddress: addresses.treasury,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      seed: PLAIN_ACCOUNT_SEED,
    }),
    /** The durable-nonce account, with the treasury as authority. */
    nonceAccount: await createAddressWithSeed({
      baseAddress: addresses.treasury,
      programAddress: SYSTEM_PROGRAM_ADDRESS,
      seed: NONCE_ACCOUNT_SEED,
    }),
  };
}

export type Cast = Awaited<ReturnType<typeof createCast>>;

/** The Keychain memory-backend signer for a role: the inner signer the scenes wrap. */
export function keychainSigner(cast: Cast, role: Role) {
  return createKeychainSigner({ backend: 'memory', keyPair: cast.keys[role] });
}

/** The raw key as a Kit signer. Setup and recycling only; never used in a scene. */
export function setupSigner(cast: Cast, role: Role): Promise<KeyPairSigner> {
  return createSignerFromKeyPair(cast.keys[role]);
}

/** Public addresses with their fictional names, for printing and the run record. */
export function castTable(cast: Cast): { role: Role; name: string; address: Address }[] {
  return ROLES.map((role) => ({ role, name: NAMES[role], address: cast[role] }));
}
