// The local x402 services: a facilitator, a shop and a second, hostile shop.
// Every server listens on 127.0.0.1 only. No tunnels, no public URLs.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Express } from 'express';
import { type Address, type KeyPairSigner, createSolanaRpc } from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { getDefaultAsset, toFacilitatorSvmSigner } from '@x402/svm';
import { ExactSvmScheme as FacilitatorScheme } from '@x402/svm/exact/facilitator';
import { ExactSvmScheme as ServerScheme } from '@x402/svm/exact/server';

import {
  type PolicyNetwork,
  type X402VerifierConfig,
  type X402VerifierDecision,
  createRpcSnapshotLoader,
} from '@nexbridge/solana-signing-firewall';
import { withX402Verifier } from '@nexbridge/solana-signing-firewall-x402';

export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const HOST = '127.0.0.1';
export const PORTS = { facilitator: 4020, shop: 4021, secondShop: 4022 } as const;
export const REPORT_PRICE = '20000';

export type Running = { url: string; close: () => Promise<void> };

/** Starts an app on 127.0.0.1. Port 0 picks a free port (tests). */
export async function listen(app: Express, port: number): Promise<Running> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, HOST, () => { resolve(s); });
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://${HOST}:${bound}`,
    close: () => new Promise((resolve) => server.close(() => { resolve(); })),
  };
}

/**
 * The local facilitator: the @x402/svm facilitator scheme wrapped with our
 * verifier, serving /supported, /verify and /settle.
 */
export function facilitatorApp(options: {
  readonly feePayer: KeyPairSigner;
  readonly rpcUrl: string;
  readonly config: X402VerifierConfig;
  readonly loaderNetwork: PolicyNetwork;
  readonly onDecision?: (decision: X402VerifierDecision) => void;
  readonly onSettle?: (result: unknown) => void;
}): Express {
  const signer = toFacilitatorSvmSigner(options.feePayer, { defaultRpcUrl: options.rpcUrl });
  const inner = new FacilitatorScheme(signer, undefined, { transactionVersions: [0, 1] });
  const scheme = withX402Verifier(inner, {
    config: options.config,
    loader: createRpcSnapshotLoader(createSolanaRpc(options.rpcUrl)),
    network: options.loaderNetwork,
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
  });
  const facilitator = new x402Facilitator().register(DEVNET, scheme);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get('/supported', (_req, res) => {
    res.json(facilitator.getSupported());
  });
  app.post('/verify', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  });
  app.post('/settle', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    options.onSettle?.(result);
    res.json(result);
  });
  return app;
}

/** The shop: one report, priced at 0.02 USDC, sold through @x402/express. */
export function shopApp(options: {
  readonly payTo: Address;
  readonly asset: Address;
  readonly facilitatorUrl: string;
}): Express {
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: options.facilitatorUrl }),
  ).register(DEVNET, new ServerScheme());
  const app = express();
  app.use(
    paymentMiddleware(
      {
        'GET /report': {
          accepts: [
            {
              scheme: 'exact',
              price: { amount: REPORT_PRICE, asset: options.asset },
              network: DEVNET,
              payTo: options.payTo,
              maxTimeoutSeconds: 60,
            },
          ],
          description: 'A short market report (fictional)',
          mimeType: 'text/plain',
        },
      },
      resourceServer,
    ),
  );
  app.get('/report', (_req, res) => {
    res
      .type('text/plain')
      .send(
        'Lantern Row Market Note (fictional): orders for small hardware rose this week; nothing here is real data.\n',
      );
  });
  return app;
}

/** The four options the second shop offers in scene 13 (docs/DECISIONS.md D10). */
export function hostileOptions(parties: {
  readonly shop: Address;
  readonly outsider: Address;
  readonly agent: Address;
  readonly feePayer: Address;
  readonly usdc: Address;
}): PaymentRequirements[] {
  const option = (
    amount: string,
    payTo: Address,
    asset: Address,
    feePayer: Address,
  ): PaymentRequirements => ({
    scheme: 'exact',
    network: DEVNET,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer, transactionVersions: [0, 1] },
  });
  return [
    option('10000', parties.outsider, parties.usdc, parties.feePayer),
    option('10000', parties.shop, parties.usdc, parties.agent),
    option(
      '10000',
      parties.shop,
      getDefaultAsset(DEVNET, 'PYUSD').asset as Address,
      parties.feePayer,
    ),
    option('2000000', parties.outsider, parties.usdc, parties.feePayer),
  ];
}

/** The second shop: a hand-written 402 with the hostile options. No @x402 middleware. */
export function secondShopApp(options: { readonly accepts: PaymentRequirements[] }): Express {
  const app = express();
  app.get('/report', (req, res) => {
    const paymentRequired = {
      x402Version: 2,
      error: 'Payment required',
      resource: {
        url: `http://${HOST}${req.originalUrl}`,
        description: 'Another report',
        mimeType: 'text/plain',
      },
      accepts: options.accepts,
    };
    res
      .status(402)
      .setHeader(
        'PAYMENT-REQUIRED',
        Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
      )
      .json(paymentRequired);
  });
  return app;
}
