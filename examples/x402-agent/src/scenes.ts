// Scenes 12 to 15 (brief section 3.7). The same code runs against devnet and,
// in rehearsals, against the LiteSVM-backed local RPC; only the URL, the keys
// and the ports differ. The forged payment of scene 15 goes only to our own
// facilitator's /verify; it is never sent to a cluster.
import {
  type MessagePartialSigner,
  type Signature,
  type TransactionPartialSigner,
} from '@solana/kit';
import type { PaymentRequirements } from '@x402/core/types';

import {
  type Policy,
  type Reason,
  type X402PaymentDecision,
  type X402VerifierConfig,
  type X402VerifierDecision,
  decisionToJson,
  openFileLedger,
  requirementsDigest,
} from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  type DemoNetwork,
  type DemoRpc,
  type Log,
  NAMES,
  type QuoteRecord,
  type ReasonRecord,
  type SceneRecord,
  type StepRecord,
  explorerFor,
  keychainSigner,
  printScene,
  setupSigner,
  usdc,
  waitForConfirmation,
} from '@nexbridge/example-demo-common';

import { createAgent, paymentRequiredOf } from './agent.js';
import { facilitatorApp } from './facilitator.js';
import { forgedPayment, postToVerify } from './forged-payment.js';
import { PORTS, listen } from './net.js';
import { hostileOptions, secondShopApp } from './second-shop.js';
import { REPORT_PRICE, shopApp } from './shop.js';

export type X402Context = {
  readonly rpc: DemoRpc;
  readonly rpcUrl: string;
  readonly cast: Cast;
  readonly network: DemoNetwork;
  readonly agentPolicy: Policy;
  readonly verifierConfig: X402VerifierConfig;
  /** The agent's budget file. */
  readonly ledgerPath: string;
  /** The fixed ports 4020 to 4022 by default; tests pass 0 for free ports. */
  readonly ports?: {
    readonly facilitator: number;
    readonly shop: number;
    readonly secondShop: number;
  };
  readonly log: Log;
  readonly now?: () => Date;
  /** Called after each scene, so the run record can be written as the run goes. */
  readonly onScene?: (scene: SceneRecord) => void;
};

const reasonRecords = (reasons: readonly Reason[]): ReasonRecord[] =>
  reasons.map((r) => ({
    code: r.code,
    ...(r.path === undefined ? {} : { path: r.path }),
    ...(r.account === undefined ? {} : { account: r.account }),
  }));

const uniqueByCode = (reasons: ReasonRecord[]) =>
  reasons.filter((r, i) => reasons.findIndex((s) => s.code === r.code) === i);

const paymentJson = (payment: X402PaymentDecision) => ({
  ...decisionToJson(payment),
  x402: payment.x402,
});

function settlementOf(response: Response): { transaction?: string; payer?: string } {
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (header === null) return {};
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    transaction?: string;
    payer?: string;
  };
}

export async function runX402Scenes(ctx: X402Context): Promise<SceneRecord[]> {
  const { cast, log } = ctx;
  const ports = ctx.ports ?? PORTS;

  // The facilitator's own key, with its signing calls counted (scene 15 expects none).
  const feePayerKey = await setupSigner(cast, 'facilitatorFeePayer');
  const facilitatorSigns = { calls: 0 };
  const feePayer: TransactionPartialSigner & MessagePartialSigner = {
    address: feePayerKey.address,
    signMessages: (...args) => feePayerKey.signMessages(...args),
    signTransactions: (...args) => {
      facilitatorSigns.calls += 1;
      return feePayerKey.signTransactions(...args);
    },
  };
  const verifierDecisions: X402VerifierDecision[] = [];
  const facilitator = await listen(
    facilitatorApp({
      feePayer,
      rpcUrl: ctx.rpcUrl,
      config: ctx.verifierConfig,
      loaderNetwork: ctx.network,
      onDecision: (d) => verifierDecisions.push(d),
    }),
    ports.facilitator,
  );
  const shop = await listen(
    shopApp({ payTo: cast.shop, asset: cast.mint, facilitatorUrl: facilitator.url }),
    ports.shop,
  );
  const second = await listen(
    secondShopApp({
      accepts: hostileOptions({
        shop: cast.shop,
        outsider: cast.outsider,
        agent: cast.agent,
        feePayer: cast.facilitatorFeePayer,
        usdc: cast.mint,
      }),
    }),
    ports.secondShop,
  );
  const ledger = await openFileLedger(ctx.ledgerPath);
  log('');
  log(
    `Local x402 services on 127.0.0.1: facilitator ${facilitator.url}, shop ${shop.url}, second shop ${second.url}`,
  );

  try {
    const agent = createAgent({
      signer: await keychainSigner(cast, 'agent'),
      policy: ctx.agentPolicy,
      rpcUrl: ctx.rpcUrl,
      loaderNetwork: ctx.network,
      ledger,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    });

    /** One purchase attempt through the guard. */
    async function purchase(url: string, label: string): Promise<StepRecord> {
      // The raw options, decoded only to print them next to our decisions.
      const offered: PaymentRequirements[] = paymentRequiredOf(await fetch(url))?.accepts ?? [];
      const quotesBefore = agent.events.quotes.length;
      const paymentsBefore = agent.events.payments.length;
      const callsBefore = agent.events.signerCalls;
      let response: Response | undefined;
      let failure: string | undefined;
      try {
        response = await agent.fetch(url);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const seen = agent.events.quotes.slice(quotesBefore);
      const payment =
        agent.events.payments.length > paymentsBefore ? agent.events.payments.at(-1) : undefined;
      const quotes: QuoteRecord[] = offered.map((option, index) => {
        const digest = requirementsDigest(option);
        const decision = seen.find((q) => q.requirementsDigest === digest);
        return {
          option: index,
          requirementsDigest: digest,
          payTo: option.payTo,
          asset: option.asset,
          amount: option.amount,
          feePayer: (option.extra as { feePayer?: string } | undefined)?.feePayer,
          outcome: decision?.outcome ?? 'removed by the SDK spend controls; the guard never saw it',
          reasons: decision?.reasons.map((r) => r.code) ?? [],
        };
      });
      const usage = seen.find((q) => q.usage !== undefined)?.usage;
      const budgetNote =
        usage === undefined
          ? ''
          : ` Reserved in the last 24 h before this purchase: ${usdc(usage.reservedLast24h)} USDC.`;
      const signerCalls = agent.events.signerCalls - callsBefore;
      const settlement = response === undefined ? {} : settlementOf(response);

      if (response?.ok === true && payment !== undefined && settlement.transaction !== undefined) {
        const report = (await response.text()).trim();
        const slot = await waitForConfirmation(ctx.rpc, settlement.transaction as Signature);
        return {
          label,
          outcome: payment.outcome,
          reasons: [],
          messageDigest: payment.messageDigest,
          policyId: payment.policyId,
          signerCalls,
          sent: true,
          signature: settlement.transaction,
          slot: slot.toString(),
          ...explorerFor(ctx.network, settlement.transaction),
          decision: paymentJson(payment),
          quotes,
          note: `Paid ${usdc(payment.x402.amount ?? 0n)} USDC; the local facilitator verified and settled it.${budgetNote} Report: "${report}"`,
        };
      }
      const reasons = uniqueByCode(
        payment === undefined
          ? seen.flatMap((q) => reasonRecords(q.reasons))
          : reasonRecords(payment.reasons),
      );
      return {
        label,
        outcome: 'deny',
        reasons,
        ...(payment === undefined
          ? {}
          : { messageDigest: payment.messageDigest, decision: paymentJson(payment) }),
        signerCalls,
        sent: false,
        quotes,
        note: `${response === undefined ? 'No payment header was sent' : `HTTP ${String(response.status)}`}.${budgetNote}${failure === undefined ? '' : ` Client: ${failure.slice(0, 120)}`}`,
      };
    }

    const scenes: SceneRecord[] = [];
    const done = (scene: SceneRecord) => {
      scenes.push(scene);
      printScene(log, scene);
      ctx.onScene?.(scene);
    };

    done({
      scene: 12,
      title: `x402: the agent buys one report from ${NAMES.shop} for 0.02 USDC`,
      expected: 'allow; the local facilitator verifies and settles; the agent receives the report',
      vectors: ['x402-001', 'x402-002'],
      steps: [await purchase(`${shop.url}/report`, 'buy one report')],
    });

    done({
      scene: 13,
      title: 'x402: the second shop offers four options, each with one fault',
      expected:
        'options 1 to 3 denied by the guard (X402_PAYTO_NOT_ALLOWED, X402_FEE_PAYER_NOT_ALLOWED, X402_ASSET_NOT_ALLOWED); option 4 removed by the SDK per-payment cap; no payment header sent; signer calls 0',
      vectors: ['x402-036', 'x402-037', 'x402-035', 'x402-038'],
      steps: [await purchase(`${second.url}/report`, 'try to buy from the second shop')],
    });

    done({
      scene: 14,
      title:
        'x402: a second report (0.04 USDC spent today), then a third against a 0.05 USDC daily budget',
      expected:
        'second purchase allowed and settled; third X402_BUDGET_EXCEEDED; signer calls 0 for the third',
      vectors: ['x402-041'],
      steps: [
        await purchase(`${shop.url}/report`, 'second report'),
        await purchase(`${shop.url}/report`, 'third report'),
      ],
    });

    {
      const requirements = paymentRequiredOf(await fetch(`${shop.url}/report`))?.accepts[0];
      if (requirements === undefined) throw new Error('the shop sent no payment requirements');
      const { value: lifetime } = await ctx.rpc
        .getLatestBlockhash({ commitment: 'confirmed' })
        .send();
      const forged = await forgedPayment({
        agent: await setupSigner(cast, 'agent'),
        feePayer: cast.facilitatorFeePayer,
        mint: cast.mint,
        agentAta: cast.agentAta,
        delegate: cast.shop,
        amount: BigInt(REPORT_PRICE),
        blockhash: lifetime.blockhash,
      });
      const signsBefore = facilitatorSigns.calls;
      const verdict = await postToVerify(facilitator.url, forged, requirements);
      const decision = verifierDecisions.at(-1);
      done({
        scene: 15,
        title:
          "x402, facilitator side: a payment signed with the agent key outside the guard, whose token instruction is ApproveChecked, posted to the facilitator's /verify",
        expected:
          'the verifier returns X402_NOT_TRANSFER_CHECKED; the facilitator does not sign or settle; nothing is sent',
        vectors: ['x402-004'],
        steps: [
          {
            label: 'POST /verify',
            outcome: verdict.isValid ? 'valid' : 'invalid',
            reasons: reasonRecords(decision?.reasons ?? []),
            ...(decision?.messageDigest === undefined
              ? {}
              : { messageDigest: decision.messageDigest }),
            signerCalls: facilitatorSigns.calls - signsBefore,
            sent: false,
            ...(decision === undefined ? {} : { decision }),
            note: `invalidReason ${verdict.invalidReason ?? '-'}. Signer calls here count the facilitator's key. /settle was never called.`,
          },
        ],
      });
    }
    return scenes;
  } finally {
    await ledger.close();
    await Promise.all([second.close(), shop.close(), facilitator.close()]);
  }
}
