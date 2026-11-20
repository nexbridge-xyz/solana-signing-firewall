// Scenes 12 to 15. The same functions run against the local RPC (tests) and
// against devnet (the demo); only the URLs and keys differ.
import type { PaymentRequirements } from '@x402/core/types';

import type { createAgent } from './agent.js';
import { paymentRequiredOf } from './agent.js';
import { postToVerify } from './forged-payment.js';

type Agent = ReturnType<typeof createAgent>;

export type QuoteLine = {
  option: number;
  requirementsDigest: string;
  outcome: string;
  reasons: string[];
};

export type SceneResult = {
  scene: number;
  title: string;
  outcome: string;
  reasons: string[];
  signerCalls: number;
  quotes: QuoteLine[];
  settlement?: string;
  payer?: string;
  note?: string;
};

function quoteLines(agent: Agent, from: number): QuoteLine[] {
  return agent.events.quotes.slice(from).map((q) => ({
    option: q.index,
    requirementsDigest: q.requirementsDigest,
    outcome: q.outcome,
    reasons: q.reasons.map((r) => r.code),
  }));
}

function settlementOf(response: Response): { transaction?: string; payer?: string } {
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (header === null) return {};
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
    transaction?: string;
    payer?: string;
  };
}

/** One purchase. Returns what the agent decided and, when paid, the settlement signature. */
export async function purchase(
  agent: Agent,
  url: string,
  scene: number,
  title: string,
): Promise<SceneResult> {
  const quotesBefore = agent.events.quotes.length;
  const paymentsBefore = agent.events.payments.length;
  const callsBefore = agent.events.signerCalls;
  let outcome: string;
  let settlement: { transaction?: string; payer?: string } = {};
  let note: string | undefined;
  try {
    const response = await agent.fetch(url);
    settlement = settlementOf(response);
    outcome = response.ok ? 'paid' : `HTTP ${response.status}`;
    if (response.ok) note = (await response.text()).trim();
  } catch (error) {
    outcome = 'refused before any payment was sent';
    note = error instanceof Error ? error.message.slice(0, 160) : String(error);
  }
  const payments = agent.events.payments.slice(paymentsBefore);
  return {
    scene,
    title,
    outcome,
    reasons: [...new Set(payments.flatMap((p) => p.reasons.map((r) => r.code)))],
    signerCalls: agent.events.signerCalls - callsBefore,
    quotes: quoteLines(agent, quotesBefore),
    ...(settlement.transaction === undefined ? {} : { settlement: settlement.transaction }),
    ...(settlement.payer === undefined ? {} : { payer: settlement.payer }),
    ...(note === undefined ? {} : { note }),
  };
}

/** Scene 13: the raw options, as the second shop sent them, then the real purchase attempt. */
export async function hostileShop(
  agent: Agent,
  url: string,
): Promise<SceneResult & { options: PaymentRequirements[] }> {
  const raw = await fetch(url);
  const options = paymentRequiredOf(raw)?.accepts ?? [];
  const result = await purchase(agent, url, 13, 'The second shop offers four hostile options');
  return { ...result, options };
}

/** Scene 15: a forged ApproveChecked payment posted straight to the facilitator's /verify. */
export async function forgedVerify(
  facilitatorUrl: string,
  transaction: string,
  requirements: PaymentRequirements,
): Promise<SceneResult> {
  const verdict = await postToVerify(facilitatorUrl, transaction, requirements);
  return {
    scene: 15,
    title: 'A payment that only approves a delegate, posted to the facilitator',
    outcome: verdict.isValid ? 'valid' : 'invalid',
    reasons: verdict.invalidReason === undefined ? [] : [verdict.invalidReason],
    signerCalls: 0,
    quotes: [],
    ...(verdict.invalidMessage === undefined ? {} : { note: verdict.invalidMessage }),
  };
}
