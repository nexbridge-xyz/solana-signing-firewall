// The agent: @x402/fetch with the guard in front of its Keychain memory signer.
import { createSolanaRpc } from '@solana/kit';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import type { PaymentRequired } from '@x402/core/types';

import {
  type BudgetLedger,
  type Policy,
  type PolicyNetwork,
  type X402PaymentDecision,
  type X402QuoteDecision,
  createRpcSnapshotLoader,
  createX402Guard,
} from '@nexbridge/solana-signing-firewall';
import {
  GuardedExactSvmScheme,
  x402RequirementsFilter,
} from '@nexbridge/solana-signing-firewall-x402';
import type { createMemorySigner } from '@solana/keychain-memory';

export type AgentEvents = {
  quotes: X402QuoteDecision[];
  payments: X402PaymentDecision[];
  signerCalls: number;
};

export function createAgent(options: {
  readonly signer: Awaited<ReturnType<typeof createMemorySigner>>;
  readonly policy: Policy;
  readonly rpcUrl: string;
  readonly loaderNetwork: PolicyNetwork;
  readonly ledger: BudgetLedger;
  readonly now?: () => Date;
}) {
  const events: AgentEvents = { quotes: [], payments: [], signerCalls: 0 };
  const inner = options.signer;
  const counted = {
    address: inner.address,
    isAvailable: () => inner.isAvailable(),
    signTransactions: (...args: Parameters<typeof inner.signTransactions>) => {
      events.signerCalls += 1;
      return inner.signTransactions(...args);
    },
  };
  const guard = createX402Guard({
    inner: counted,
    policy: options.policy,
    loader: createRpcSnapshotLoader(createSolanaRpc(options.rpcUrl)),
    ledger: options.ledger,
    ...(options.now === undefined ? {} : { now: options.now }),
    onDecision: (decision) => {
      if ('index' in decision) events.quotes.push(decision);
      else events.payments.push(decision);
    },
  });
  const client = new x402Client();
  client.registerPolicy(x402RequirementsFilter(guard));
  client.register('solana:*', new GuardedExactSvmScheme(guard, { rpcUrl: options.rpcUrl }));
  return { fetch: wrapFetchWithPayment(fetch, client), events, guard };
}

/** Decodes a server's PAYMENT-REQUIRED header, for printing each option. Explanation only. */
export function paymentRequiredOf(response: Response): PaymentRequired | undefined {
  const header = response.headers.get('PAYMENT-REQUIRED');
  return header === null
    ? undefined
    : (JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired);
}
