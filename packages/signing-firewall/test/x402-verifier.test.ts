// verifyX402Payment() and parseVerifierConfig(), check by check. The vectors
// cover the spec's rules; these tests cover each branch and boundary.
import { describe, expect, it } from 'vitest';
import {
  AccountRole,
  type Address,
  type Instruction,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token';

import {
  SPL_MEMO_PROGRAM_ADDRESS,
  type Snapshot,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  VerifierConfigError,
  parseVerifierConfig,
  requirementsDigest,
  verifyX402Payment,
} from '../src/index.js';
import { BLOCKHASH } from './helpers.js';
import { mintData, tokenData } from './world.js';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const now = new Date('2026-11-20T00:00:00.000Z');

const agent = await generateKeyPairSigner();
const shop = (await generateKeyPairSigner()).address;
const feePayer = (await generateKeyPairSigner()).address;
const other = (await generateKeyPairSigner()).address;
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
function snapshot(changes: [Address, SnapshotAccount | null | 'drop'][] = []): Snapshot {
  const accounts = new Map<Address, SnapshotAccount | null>([
    [mint, owned(mintData())],
    [agentAta, owned(tokenData(mint, agent.address, 1_000_000n))],
    [shopAta, owned(tokenData(mint, shop, 0n))],
  ]);
  for (const [address, value] of changes) {
    if (value === 'drop') accounts.delete(address);
    else accounts.set(address, value);
  }
  return { slot: 1n, accounts };
}

const configJson = {
  schema: 'solana-signing-firewall.x402-verifier/v0',
  networks: [DEVNET],
  feePayers: [feePayer],
  messageVersions: ['v0', 'v1'],
  assets: { [mint]: { decimals: 6 } },
  maxComputeUnitLimit: 200000,
  maxComputeUnitPriceMicroLamports: '5000000',
  maxPriorityFeeLamports: '100000',
  maxRequiredSignatures: 2,
};
const config = parseVerifierConfig(configJson);
const configWith = (changes: Record<string, unknown>) =>
  parseVerifierConfig({ ...configJson, ...changes });

const requirements = (
  changes: Record<string, unknown> = {},
  extra: Record<string, unknown> = { feePayer },
) => ({
  scheme: 'exact',
  network: DEVNET,
  amount: '20000',
  asset: mint,
  payTo: shop,
  maxTimeoutSeconds: 60,
  extra,
  ...changes,
});

const transfer = (options: { decimals?: number; authority?: TransactionSigner } = {}) =>
  getTransferCheckedInstruction({
    source: agentAta,
    mint,
    destination: shopAta,
    authority: options.authority ?? agent,
    amount: 20_000n,
    decimals: options.decimals ?? 6,
  });
const memo = (accounts: Instruction['accounts'] = []): Instruction => ({
  programAddress: SPL_MEMO_PROGRAM_ADDRESS,
  accounts,
  data: new TextEncoder().encode('a'.repeat(32)),
});
const limit = (units: number) => getSetComputeUnitLimitInstruction({ units });
const price = (microLamports: bigint) => getSetComputeUnitPriceInstruction({ microLamports });
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 0n };

async function v0(instructions: Instruction[], tables: Record<Address, Address[]> = {}) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

async function v1(
  instructions: Instruction[],
  transactionConfig: Parameters<typeof setTransactionMessageConfig>[0] = {
    computeUnitLimit: 20_000,
    loadedAccountsDataSizeLimit: 4_194_304,
    priorityFeeLamports: 1n,
  },
) {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
    (m) => setTransactionMessageConfig(transactionConfig, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

const sdkV0 = () => v0([limit(20_000), price(1n), transfer(), memo()]);

const verify = (
  transaction: string,
  options: { requirements?: unknown; config?: typeof config; snapshot?: Snapshot } = {},
) =>
  verifyX402Payment({
    transaction,
    requirements: options.requirements ?? requirements(),
    config: options.config ?? config,
    snapshot: options.snapshot ?? snapshot(),
    now,
  });
const codes = async (...args: Parameters<typeof verify>) =>
  (await verify(...args)).reasons.map((r) => r.code);

describe('verifyX402Payment', () => {
  it('accepts the SDK layouts and reports what it read', async () => {
    const decision = await verify(await sdkV0());
    expect(decision).toMatchObject({
      outcome: 'valid',
      reasons: [],
      payer: agent.address,
      amount: 20_000n,
      version: 'v0',
      requirementsDigest: requirementsDigest(requirements()),
      snapshotSlot: 1n,
    });
    expect(decision.messageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await verify(await v1([transfer(), memo()]))).toMatchObject({
      outcome: 'valid',
      version: 'v1',
    });
  });

  it('checks the quote: scheme, network, asset, fee payer, amount and splits', async () => {
    const payment = await sdkV0();
    expect(await codes(payment, { requirements: requirements({ scheme: 'upto' }) })).toContain(
      'X402_SCHEME_NOT_ALLOWED',
    );
    expect(await codes(payment, { requirements: requirements({ network: MAINNET }) })).toContain(
      'X402_NETWORK_NOT_ALLOWED',
    );
    expect(await codes(payment, { requirements: requirements({ asset: other }) })).toContain(
      'X402_ASSET_NOT_ALLOWED',
    );
    const noFeePayer = await verify(payment, { requirements: requirements({}, {}) });
    expect(noFeePayer.reasons).toContainEqual({ code: 'X402_FEE_PAYER_NOT_ALLOWED' });
    const otherFeePayer = await verify(payment, {
      requirements: requirements({}, { feePayer: other }),
    });
    expect(otherFeePayer.reasons).toContainEqual({
      code: 'X402_FEE_PAYER_NOT_ALLOWED',
      account: other,
    });
    expect(await codes(payment, { requirements: requirements({ amount: '0' }) })).toContain(
      'ZERO_AMOUNT',
    );
    expect(
      await codes(payment, { requirements: requirements({}, { feePayer, splits: [{}] }) }),
    ).toContain('X402_SPLITS_NOT_ALLOWED');
  });

  it('stops at malformed requirements and at bytes that do not decode', async () => {
    const malformed = await verify(await sdkV0(), { requirements: requirements({ amount: 5 }) });
    expect(malformed.reasons.map((r) => r.code)).toEqual(['X402_REQUIREMENTS_MALFORMED']);
    expect(malformed).toMatchObject({ outcome: 'invalid', messageDigest: undefined });
    for (const transaction of ['not base64!', 'AAAA']) {
      const decision = await verify(transaction);
      expect(decision.reasons.map((r) => r.code)).toEqual(['MALFORMED_MESSAGE']);
      expect(decision.messageDigest).toBeUndefined();
    }
    // Decodes as a transaction, but its lookup table is not in the snapshot.
    const table = (await generateKeyPairSigner()).address;
    const unresolved = await verify(
      await v0([limit(20_000), price(1n), transfer(), memo()], { [table]: [shopAta, mint] }),
    );
    expect(unresolved.reasons.map((r) => r.code)).toEqual(['LOOKUP_TABLE_UNRESOLVED']);
    expect(unresolved).toMatchObject({ version: 'v0', payer: undefined });
    expect(unresolved.messageDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies its own version list', async () => {
    const onlyV1 = configWith({ messageVersions: ['v1'] });
    expect(await codes(await sdkV0(), { config: onlyV1 })).toEqual(['VERSION_NOT_ALLOWED']);
    expect(await codes(await v1([transfer(), memo()]), { config: onlyV1 })).toEqual([]);
  });

  it('reports a durable nonce only for a nonce advance, not for any System instruction', async () => {
    const extra = getTransferSolInstruction({ source: agent, destination: shop, amount: 1n });
    const reasons = await codes(await v0([limit(20_000), price(1n), transfer(), memo(), extra]));
    expect(reasons).toContain('X402_LAYOUT_INVALID');
    expect(reasons).not.toContain('DURABLE_NONCE_NOT_ALLOWED');
  });

  it('checks the compute-unit limit', async () => {
    expect(await codes(await v0([limit(200_000), price(1n), transfer(), memo()]))).toEqual([]);
    expect(await codes(await v0([limit(200_001), price(1n), transfer(), memo()]))).toEqual([
      'COMPUTE_UNIT_LIMIT_EXCEEDED',
    ]);
    const noLimit = await codes(
      await v1([transfer(), memo()], {
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports: 1n,
      }),
    );
    expect(noLimit).toContain('COMPUTE_UNIT_LIMIT_MISSING');
  });

  it('caps the total priority fee, and allows exactly the cap', async () => {
    // 20,000 units at 5,000,000 micro-lamports: exactly 100,000 lamports and exactly the price cap.
    expect(await codes(await v0([limit(20_000), price(5_000_000n), transfer(), memo()]))).toEqual(
      [],
    );
    expect(await codes(await v0([limit(20_000), price(5_000_001n), transfer(), memo()]))).toEqual(
      expect.arrayContaining(['FEE_CAP_EXCEEDED', 'X402_COMPUTE_UNIT_PRICE_EXCEEDED']),
    );
    // Without a limit the fee is costed at 1,400,000 units: 100 micro-lamports cost 140 lamports.
    const noLimit = await v0([price(100n), transfer(), memo()]);
    expect(
      await codes(noLimit, { config: configWith({ maxPriorityFeeLamports: '139' }) }),
    ).toContain('FEE_CAP_EXCEEDED');
    expect(
      await codes(noLimit, { config: configWith({ maxPriorityFeeLamports: '140' }) }),
    ).not.toContain('FEE_CAP_EXCEEDED');
    // Version 1: the fee is the total in transactionConfig.
    const fee = (priorityFeeLamports: bigint) =>
      v1([transfer(), memo()], {
        computeUnitLimit: 200_000,
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports,
      });
    expect(await codes(await fee(100_000n))).toEqual([]);
    expect(await codes(await fee(100_001n))).toEqual(['FEE_CAP_EXCEEDED']);
  });

  it('allows only the buyer and the fee payer as signers, within the configured count', async () => {
    const payment = await sdkV0();
    const tooMany = await verify(payment, { config: configWith({ maxRequiredSignatures: 1 }) });
    expect(tooMany.reasons.map((r) => r.code)).toEqual(['UNEXPECTED_SIGNER']);
    const third = await v0([
      limit(20_000),
      price(1n),
      transfer(),
      memo([{ address: other, role: AccountRole.READONLY_SIGNER }]),
    ]);
    const within = await verify(third, { config: configWith({ maxRequiredSignatures: 3 }) });
    expect(within.reasons).toEqual([{ code: 'UNEXPECTED_SIGNER', account: other }]);
  });

  it("verifies the buyer's signature over these exact bytes", async () => {
    const unsigned = await v0([
      limit(20_000),
      price(1n),
      transfer({ authority: createNoopSigner(agent.address) }),
      memo(),
    ]);
    expect((await verify(unsigned)).reasons).toEqual([
      { code: 'X402_PAYER_SIGNATURE_INVALID', account: agent.address },
    ]);
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(await sdkV0()));
    const signature = new Uint8Array(wire.signatures[agent.address] ?? new Uint8Array(64));
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    const forged = getTransactionEncoder().encode({
      ...wire,
      signatures: { ...wire.signatures, [agent.address]: signature },
    });
    const base64 = Buffer.from(forged).toString('base64');
    expect(await codes(base64)).toEqual(['X402_PAYER_SIGNATURE_INVALID']);
  });

  it('checks the decimals and that the accounts exist', async () => {
    expect(
      await codes(await v0([limit(20_000), price(1n), transfer({ decimals: 9 }), memo()])),
    ).toContain('DECIMALS_MISMATCH');
    const payment = await sdkV0();
    expect(
      (await verify(payment, { snapshot: snapshot([[agentAta, 'drop']]) })).reasons,
    ).toContainEqual({ code: 'ACCOUNT_STATE_MISSING', account: agentAta });
    expect(
      (await verify(payment, { snapshot: snapshot([[agentAta, null]]) })).reasons,
    ).toContainEqual({
      code: 'X402_SOURCE_ACCOUNT_MISSING',
      account: agentAta,
    });
    expect(
      (await verify(payment, { snapshot: snapshot([[shopAta, 'drop']]) })).reasons,
    ).toContainEqual({
      code: 'ACCOUNT_STATE_MISSING',
      account: shopAta,
    });
    expect(
      (await verify(payment, { snapshot: snapshot([[shopAta, null]]) })).reasons,
    ).toContainEqual({
      code: 'DESTINATION_ACCOUNT_MISSING',
      account: shopAta,
    });
  });
});

describe('parseVerifierConfig, field by field', () => {
  it('fills the deny switches and keeps every value', () => {
    expect(config).toEqual({
      networks: [DEVNET],
      feePayers: [feePayer],
      messageVersions: ['v0', 'v1'],
      assets: new Map([[mint, { decimals: 6 }]]),
      maxComputeUnitLimit: 200000,
      maxComputeUnitPriceMicroLamports: 5_000_000n,
      maxPriorityFeeLamports: 100_000n,
      maxRequiredSignatures: 2,
      durableNonce: 'deny',
      createRecipientAccount: 'deny',
      lookupTables: 'deny',
    });
    expect(configWith({ durableNonce: 'deny', createRecipientAccount: 'deny' }).durableNonce).toBe(
      'deny',
    );
  });

  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    ['config', /must be an object/],
    [{ ...configJson, schema: 'v0' }, /schema must be "solana-signing-firewall.x402-verifier\/v0"/],
    [{ ...configJson, networks: [] }, /networks must be a non-empty array of strings/],
    [{ ...configJson, networks: [DEVNET, 5] }, /networks must be a non-empty array of strings/],
    [{ ...configJson, networks: DEVNET }, /networks must be a non-empty array of strings/],
    [{ ...configJson, feePayers: [] }, /feePayers must be a non-empty array of strings/],
    [{ ...configJson, feePayers: ['nope'] }, /feePayers: nope is not an address/],
    [{ ...configJson, messageVersions: [] }, /messageVersions must be a non-empty array/],
    [{ ...configJson, assets: null }, /assets must be an object/],
    [{ ...configJson, assets: [] }, /assets must be an object/],
    [{ ...configJson, assets: {} }, /assets must name at least one mint/],
    [{ ...configJson, assets: { nope: { decimals: 6 } } }, /assets.nope is invalid/],
    [{ ...configJson, assets: { [mint]: null } }, /is invalid/],
    [{ ...configJson, assets: { [mint]: { decimals: 1.5 } } }, /is invalid/],
    [{ ...configJson, assets: { [mint]: { decimals: '6' } } }, /is invalid/],
    [{ ...configJson, assets: { [mint]: { decimals: -1 } } }, /is invalid/],
    [{ ...configJson, assets: { [mint]: { decimals: 256 } } }, /is invalid/],
    [{ ...configJson, maxComputeUnitLimit: 0 }, /maxComputeUnitLimit must be a positive integer/],
    [{ ...configJson, maxComputeUnitLimit: 1.5 }, /maxComputeUnitLimit must be a positive integer/],
    [{ ...configJson, maxComputeUnitLimit: '1' }, /maxComputeUnitLimit must be a positive integer/],
    [
      { ...configJson, maxComputeUnitPriceMicroLamports: 5 },
      /maxComputeUnitPriceMicroLamports must be a decimal string/,
    ],
    [
      { ...configJson, maxComputeUnitPriceMicroLamports: 'x5000000' },
      /maxComputeUnitPriceMicroLamports must be a decimal string/,
    ],
    [
      { ...configJson, maxPriorityFeeLamports: '100000x' },
      /maxPriorityFeeLamports must be a decimal string/,
    ],
    [
      { ...configJson, maxRequiredSignatures: 0 },
      /maxRequiredSignatures must be a positive integer/,
    ],
    [{ ...configJson, durableNonce: 'allow' }, /durableNonce must be "deny"/],
    [{ ...configJson, createRecipientAccount: 'allow' }, /createRecipientAccount must be "deny"/],
    [{ ...configJson, lookupTables: 'allow' }, /lookupTables must be "deny"/],
  ])('refuses case %#', (bad, message) => {
    expect(() => parseVerifierConfig(bad)).toThrow(VerifierConfigError);
    expect(() => parseVerifierConfig(bad)).toThrow(message);
  });

  it('names its error class', () => {
    expect(new VerifierConfigError('x').name).toBe('VerifierConfigError');
  });
});
