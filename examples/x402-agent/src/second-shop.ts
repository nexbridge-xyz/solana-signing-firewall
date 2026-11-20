// second-shop.ts on 127.0.0.1:4022: a hand-written 402 whose PAYMENT-REQUIRED
// carries the scene 13 options. No @x402 middleware.
import express, { type Express } from 'express';
import type { Address } from '@solana/kit';
import type { PaymentRequirements } from '@x402/core/types';
import { getDefaultAsset } from '@x402/svm';

import { DEVNET, HOST } from './net.js';

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
