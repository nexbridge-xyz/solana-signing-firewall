import { describe, expect, it } from 'vitest';
import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
} from '@x402/core/types';
import { getDefaultAsset } from '@x402/svm';
import { getApproveCheckedInstruction } from '@solana-program/token';
import { createMemorySigner } from '@solana/keychain-memory';

import {
  SPL_MEMO_PROGRAM_ADDRESS,
  type SnapshotAccount,
  type X402QuoteDecision,
  createMemoryLedger,
  createX402Guard,
  parsePolicy,
  parseVerifierConfig,
  staticSnapshotLoader,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';
import {
  DEVNET,
  FIXED_BLOCKHASH_FOR_TESTS,
  agentPolicy,
  budgetInstructions,
  createX402World,
  facilitatorConfig,
  handBuilt,
  memoInstruction,
  quote,
  sdkBuilt,
  startStubRpc,
  x402Accounts,
} from '@nexbridge/solana-signing-firewall-fixtures/x402';

import {
  GuardedExactSvmScheme,
  REASON_PREFIX,
  withX402Verifier,
  x402RequirementsFilter,
} from '../src/index.js';

const w = await createX402World();
const accounts = new Map(x402Accounts(w) as [Address, SnapshotAccount][]);
const snapshot = { slot: 1000n, accounts: new Map(x402Accounts(w)) };
const loader = staticSnapshotLoader(snapshot);
const policy = { ...parsePolicy({ ...agentPolicy(w), network: 'localnet' }) };
const config = parseVerifierConfig(facilitatorConfig(w));
const now = () => new Date('2026-11-20T00:00:00.000Z');

function programsOf(transaction: string): Address[] {
  const wire = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
  if (message.version === 1) {
    return message.instructionHeaders.map(
      (h) => message.staticAccounts[h.programAccountIndex] as Address,
    );
  }
  return message.instructions.map(
    (ix) => message.staticAccounts[ix.programAddressIndex] as Address,
  );
}

describe('the Memo program', () => {
  it.each([[[0]], [[0, 1]]])(
    'is the one the SDK uses (transactionVersions %j)',
    async (versions) => {
      const requirements = quote(
        w,
        {},
        { transactionVersions: versions, recentBlockhash: FIXED_BLOCKHASH_FOR_TESTS },
      );
      const transaction = await sdkBuilt(
        w,
        requirements as PaymentRequirements,
        accounts,
        'memo-check',
      );
      const programs = programsOf(transaction);
      expect(programs.at(-1)).toBe(SPL_MEMO_PROGRAM_ADDRESS);
    },
  );
});

describe('paying through x402Client with the guard', () => {
  async function client(onDecisions?: (d: readonly X402QuoteDecision[]) => void) {
    const rpc = await startStubRpc(accounts);
    const ledger = createMemoryLedger();
    const inner = await createMemorySigner({ keyPair: w.agent.keyPair });
    const guard = createX402Guard({ inner, policy, loader, ledger, now });
    const c = new x402Client();
    c.registerPolicy(x402RequirementsFilter(guard, onDecisions));
    c.register('solana:*', new GuardedExactSvmScheme(guard, { rpcUrl: rpc.url }));
    return { c, ledger, close: rpc.close };
  }

  const paymentRequired = (accepts: unknown[]) => ({
    x402Version: 2,
    resource: {
      url: 'http://127.0.0.1:4021/report',
      description: 'report',
      mimeType: 'text/plain',
    },
    accepts: accepts as PaymentRequirements[],
  });

  it('signs the accepted quote, reserves it, and the verifier accepts the payment', async () => {
    const { c, ledger, close } = await client();
    try {
      const requirements = quote(w, {}, { recentBlockhash: FIXED_BLOCKHASH_FOR_TESTS });
      const payload = await c.createPaymentPayload(paymentRequired([requirements]));
      const transaction = (payload.payload as { transaction: string }).transaction;
      const decision = await verifyX402Payment({
        transaction,
        requirements,
        config,
        snapshot,
        now: now(),
      });
      expect(decision.reasons).toEqual([]);
      expect((await ledger.reservations()).map((r) => r.amount)).toEqual([20_000n]);
    } finally {
      close();
    }
  });

  it('blocks the hostile options of scene 13 on the real path, with the SDK spend controls on', async () => {
    const seen: X402QuoteDecision[] = [];
    const { c, ledger, close } = await client((d) => seen.push(...d));
    try {
      const options = [
        quote(w, { amount: '10000', payTo: w.outsider.address }),
        quote(w, { amount: '10000' }, { feePayer: w.agent.address }),
        quote(w, { amount: '10000', asset: getDefaultAsset(DEVNET, 'PYUSD').asset }),
        quote(w, { amount: '2000000', payTo: w.outsider.address }),
      ];
      await expect(c.createPaymentPayload(paymentRequired(options))).rejects.toThrow();
      // The 2.00 USDC option never reaches the guard: the SDK's per-payment cap removes it first.
      expect(seen.map((d) => d.reasons.map((r) => r.code))).toEqual([
        ['X402_PAYTO_NOT_ALLOWED'],
        ['X402_FEE_PAYER_NOT_ALLOWED'],
        ['X402_ASSET_NOT_ALLOWED'],
      ]);
      expect(await ledger.reservations()).toEqual([]);
    } finally {
      close();
    }
  });
});

describe('withX402Verifier', () => {
  function spyFacilitator() {
    const calls = { verify: 0, settle: 0 };
    const inner: SchemeNetworkFacilitator = {
      scheme: 'exact',
      caipFamily: 'solana:*',
      getExtra: () => ({ feePayer: w.feePayer.address }),
      getSigners: () => [w.feePayer.address],
      verify: () => {
        calls.verify += 1;
        return Promise.resolve({ isValid: true, payer: w.agent.address });
      },
      settle: () => {
        calls.settle += 1;
        return Promise.resolve({ success: true, transaction: 'sig', network: DEVNET });
      },
    };
    return { inner, calls };
  }

  const payload = (transaction: string, accepted: unknown): PaymentPayload => ({
    x402Version: 2,
    accepted: accepted as PaymentRequirements,
    payload: { transaction },
  });

  it('refuses a payment that only approves a delegate, without calling the inner facilitator (scene 15)', async () => {
    const { inner, calls } = spyFacilitator();
    const wrapped = withX402Verifier(inner, { config, loader, network: 'localnet', now });
    const requirements = quote(w) as PaymentRequirements;
    const forged = await handBuilt(w, {
      version: 0,
      instructions: [
        ...budgetInstructions(),
        getApproveCheckedInstruction({
          source: w.agentAta,
          mint: w.mint,
          delegate: w.shop.address,
          owner: w.agent,
          amount: 20_000n,
          decimals: 6,
        }),
        memoInstruction('0'.repeat(32)),
      ],
    });
    const verdict = await wrapped.verify(payload(forged, requirements), requirements);
    expect(verdict).toMatchObject({
      isValid: false,
      invalidReason: `${REASON_PREFIX}X402_NOT_TRANSFER_CHECKED`,
    });
    const settled = await wrapped.settle(payload(forged, requirements), requirements);
    expect(settled).toMatchObject({
      success: false,
      errorReason: `${REASON_PREFIX}X402_NOT_TRANSFER_CHECKED`,
    });
    expect(calls).toEqual({ verify: 0, settle: 0 });
  });

  it('delegates a valid payment, and checks it again before settling', async () => {
    const { inner, calls } = spyFacilitator();
    const wrapped = withX402Verifier(inner, { config, loader, network: 'localnet', now });
    const requirements = quote(
      w,
      {},
      { transactionVersions: [0], recentBlockhash: FIXED_BLOCKHASH_FOR_TESTS },
    );
    const transaction = await sdkBuilt(
      w,
      requirements as PaymentRequirements,
      accounts,
      'delegate',
    );
    expect(
      (
        await wrapped.verify(
          payload(transaction, requirements),
          requirements as PaymentRequirements,
        )
      ).isValid,
    ).toBe(true);
    expect(
      (
        await wrapped.settle(
          payload(transaction, requirements),
          requirements as PaymentRequirements,
        )
      ).success,
    ).toBe(true);
    expect(calls).toEqual({ verify: 1, settle: 1 });
    expect(wrapped.getSigners(DEVNET)).toEqual([w.feePayer.address]);
  });
});
