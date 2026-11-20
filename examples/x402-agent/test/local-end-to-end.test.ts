// Scenes 12 to 15 end to end on this machine: a LiteSVM-backed RPC, the local
// facilitator, the shop, the second shop and the agent, all on 127.0.0.1.
import { describe, expect, it } from 'vitest';
import { type Address, lamports } from '@solana/kit';
import { createMemorySigner } from '@solana/keychain-memory';
import { getTokenDecoder } from '@solana-program/token';
import type { PaymentRequirements } from '@x402/core/types';

import {
  createMemoryLedger,
  parsePolicy,
  parseVerifierConfig,
  type X402VerifierDecision,
} from '@nexbridge/solana-signing-firewall';
import {
  agentPolicy,
  createX402World,
  facilitatorConfig,
  quote,
  x402Accounts,
} from '@nexbridge/solana-signing-firewall-fixtures/x402';

import { createAgent } from '../src/agent.js';
import { forgedPayment } from '../src/forged-payment.js';
import { startLocalRpc } from '../src/local-rpc.js';
import { forgedVerify, hostileShop, purchase } from '../src/scenes.js';
import { facilitatorApp, hostileOptions, listen, secondShopApp, shopApp } from '../src/services.js';

const w = await createX402World();

describe('x402 scenes 12 to 15, locally', () => {
  it('pays the quote, refuses hostile quotes and the budget overrun, and the facilitator refuses a forged payment', async () => {
    const rpc = await startLocalRpc();
    rpc.svm.airdrop(w.feePayer.address, lamports(2_000_000_000n));
    for (const [address, account] of x402Accounts(w)) {
      if (account === null) continue;
      rpc.svm.setAccount({
        address,
        data: account.data,
        executable: account.executable,
        lamports: lamports(account.lamports),
        programAddress: account.owner,
        space: BigInt(account.data.length),
      });
    }
    const balance = (account: Address) => {
      const found = rpc.svm.getAccount(account);
      return found.exists ? getTokenDecoder().decode(found.data).amount : 0n;
    };

    const verifierDecisions: X402VerifierDecision[] = [];
    const facilitator = await listen(
      facilitatorApp({
        feePayer: w.feePayer,
        rpcUrl: rpc.url,
        config: parseVerifierConfig(facilitatorConfig(w)),
        loaderNetwork: 'localnet',
        onDecision: (d) => verifierDecisions.push(d),
      }),
      0,
    );
    const shop = await listen(
      shopApp({ payTo: w.shop.address, asset: w.mint, facilitatorUrl: facilitator.url }),
      0,
    );
    const second = await listen(
      secondShopApp({
        accepts: hostileOptions({
          shop: w.shop.address,
          outsider: w.outsider.address,
          agent: w.agent.address,
          feePayer: w.feePayer.address,
          usdc: w.mint,
        }),
      }),
      0,
    );

    try {
      const agent = createAgent({
        signer: await createMemorySigner({ keyPair: w.agent.keyPair }),
        policy: parsePolicy({ ...agentPolicy(w), network: 'localnet' }),
        rpcUrl: rpc.url,
        loaderNetwork: 'localnet',
        ledger: createMemoryLedger(),
      });

      const s12 = await purchase(agent, `${shop.url}/report`, 12, 'Buy one report for 0.02 USDC');
      expect(s12).toMatchObject({ outcome: 'paid', reasons: [], signerCalls: 1 });
      expect(s12.settlement).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      expect(balance(w.shopAta)).toBe(20_000n);

      const s13 = await hostileShop(agent, `${second.url}/report`);
      expect(s13.options).toHaveLength(4);
      expect(s13).toMatchObject({ outcome: 'refused before any payment was sent', signerCalls: 0 });
      expect(s13.quotes.map((q) => q.reasons)).toEqual([
        ['X402_PAYTO_NOT_ALLOWED'],
        ['X402_FEE_PAYER_NOT_ALLOWED'],
        ['X402_ASSET_NOT_ALLOWED'],
      ]);

      const second14 = await purchase(
        agent,
        `${shop.url}/report`,
        14,
        'A second report (0.04 USDC spent today)',
      );
      expect(second14).toMatchObject({ outcome: 'paid', signerCalls: 1 });
      const third14 = await purchase(
        agent,
        `${shop.url}/report`,
        14,
        'A third report against a 0.05 USDC budget',
      );
      expect(third14).toMatchObject({
        outcome: 'refused before any payment was sent',
        signerCalls: 0,
      });
      expect(third14.quotes.map((q) => q.reasons)).toEqual([['X402_BUDGET_EXCEEDED']]);
      expect(balance(w.shopAta)).toBe(40_000n);

      const forged = await forgedPayment({
        agent: w.agent,
        feePayer: w.feePayer.address,
        mint: w.mint,
        agentAta: w.agentAta,
        delegate: w.shop.address,
        amount: 20_000n,
        blockhash: rpc.svm.latestBlockhash(),
      });
      const s15 = await forgedVerify(facilitator.url, forged, quote(w) as PaymentRequirements);
      expect(s15).toMatchObject({
        outcome: 'invalid',
        reasons: ['solana-signing-firewall:X402_NOT_TRANSFER_CHECKED'],
      });
      expect(balance(w.shopAta)).toBe(40_000n);
      expect(verifierDecisions.at(-1)?.reasons.map((r) => r.code)).toContain(
        'X402_NOT_TRANSFER_CHECKED',
      );
    } finally {
      await Promise.all([second.close(), shop.close(), facilitator.close(), rpc.close()]);
    }
  });
});
