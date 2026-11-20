// The cast of the x402 vectors: an agent that pays, a shop that sells, the local
// facilitator's fee payer, and the outsider. Keys come from fixed seeds.
import type { Address } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { findAssociatedTokenPda as findAta2022 } from '@solana-program/token-2022';

import {
  type SnapshotAccount,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '@nexbridge/solana-signing-firewall';

import { DEVNET_USDC_MINT, fixtureSigner, rentExempt, tokenAccount } from '../world.js';
import { getMintEncoder, getTokenEncoder, AccountState } from '@solana-program/token';

/** CAIP-2 ID of Solana devnet. */
export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export type X402World = Awaited<ReturnType<typeof createX402World>>;

export async function createX402World() {
  const agent = await fixtureSigner('x402-agent');
  const shop = await fixtureSigner('x402-shop');
  const feePayer = await fixtureSigner('x402-facilitator-fee-payer');
  const outsider = await fixtureSigner('outsider');
  const token2022Mint = (await fixtureSigner('x402-token-2022-mint')).address;
  const otherMint = (await fixtureSigner('x402-other-spl-mint')).address;
  const ata = async (owner: Address) =>
    (
      await findAssociatedTokenPda({
        owner,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
    )[0];
  const ata2022 = async (owner: Address) =>
    (
      await findAta2022({ owner, mint: token2022Mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    )[0];
  return {
    agent,
    shop,
    feePayer,
    outsider,
    signers: new Map([agent, shop, feePayer, outsider].map((s) => [s.address, s])),
    mint: DEVNET_USDC_MINT,
    token2022Mint,
    otherMint,
    agentAta: await ata(agent.address),
    shopAta: await ata(shop.address),
    outsiderAta: await ata(outsider.address),
    feePayerAta: await ata(feePayer.address),
    agentAta2022: await ata2022(agent.address),
    shopAta2022: await ata2022(shop.address),
    lookupTable: (await fixtureSigner('x402-lookup-table')).address,
    nonceAccount: (await fixtureSigner('x402-nonce-account')).address,
  };
}

export function mint(owner: Address): SnapshotAccount {
  const data = new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
    }),
  );
  return { owner, lamports: rentExempt(data.length), data, executable: false };
}

function token2022Account(mintAddress: Address, owner: Address, amount: bigint): SnapshotAccount {
  const data = new Uint8Array(
    getTokenEncoder().encode({
      mint: mintAddress,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  );
  return {
    owner: TOKEN_2022_PROGRAM_ADDRESS,
    lamports: rentExempt(data.length),
    data,
    executable: false,
  };
}

/** Mints and token accounts every payment vector can see. */
export function x402Accounts(w: X402World): [Address, SnapshotAccount | null][] {
  return [
    [w.mint, mint(TOKEN_PROGRAM_ADDRESS)],
    [w.agentAta, tokenAccount(w.mint, w.agent.address, 100_000n)],
    [w.shopAta, tokenAccount(w.mint, w.shop.address, 0n)],
    [w.outsiderAta, tokenAccount(w.mint, w.outsider.address, 0n)],
    [w.feePayerAta, tokenAccount(w.mint, w.feePayer.address, 100_000n)],
    [w.token2022Mint, mint(TOKEN_2022_PROGRAM_ADDRESS)],
    [w.agentAta2022, token2022Account(w.token2022Mint, w.agent.address, 100_000n)],
    [w.shopAta2022, token2022Account(w.token2022Mint, w.shop.address, 0n)],
  ];
}

/** The demo agent's policy (brief section 3.9.2), with D6 and D7 applied. */
export function agentPolicy(w: X402World) {
  return {
    schema: 'solana-signing-firewall.policy/v0',
    policyId: 'fixtures-agent',
    network: 'devnet',
    signer: w.agent.address,
    feePayers: [w.feePayer.address],
    messageVersions: ['v0', 'v1'],
    durableNonce: 'deny',
    tokenBatch: 'deny',
    mints: { [w.mint]: { decimals: 6, maxPerTransaction: '20000' } },
    sources: [w.agentAta],
    recipients: { owners: [w.shop.address], requireAssociatedTokenAccount: true },
    fees: {
      maxComputeUnitLimit: 200000,
      maxPriorityFeeLamports: '50000',
      requireExplicitComputeUnitLimit: true,
    },
    memo: { allowed: true, maxBytes: 256 },
    x402: {
      networks: [DEVNET],
      schemes: ['exact'],
      maxTimeoutSeconds: 120,
      maxComputeUnitPriceMicroLamports: '5000000',
      createRecipientAccount: 'deny',
      lookupTables: 'deny',
      budgets: { [w.mint]: { maxPerDay: '50000' } },
      maxPaymentsPerMinute: 10,
    },
  };
}

/** The local facilitator's verifier config (brief section 3.9.5), with D6 applied. */
export function facilitatorConfig(w: X402World) {
  return {
    schema: 'solana-signing-firewall.x402-verifier/v0',
    networks: [DEVNET],
    feePayers: [w.feePayer.address],
    messageVersions: ['v0', 'v1'],
    assets: { [w.mint]: { decimals: 6 } },
    maxComputeUnitLimit: 200000,
    maxComputeUnitPriceMicroLamports: '5000000',
    maxPriorityFeeLamports: '100000',
    maxRequiredSignatures: 2,
    durableNonce: 'deny',
    createRecipientAccount: 'deny',
    lookupTables: 'deny',
  };
}

/** A quote from the shop: 0.02 USDC, the facilitator pays the fee. */
export function quote(
  w: X402World,
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    scheme: 'exact',
    network: DEVNET,
    amount: '20000',
    asset: w.mint,
    payTo: w.shop.address,
    maxTimeoutSeconds: 60,
    ...overrides,
    extra: { feePayer: w.feePayer.address, transactionVersions: [0, 1], ...extra },
  };
}
