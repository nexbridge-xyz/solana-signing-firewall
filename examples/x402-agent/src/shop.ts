// shop.ts on 127.0.0.1:4021: @x402/express with GET /report at 0.02 USDC, paid
// to the shop. It returns a short fictional report.
import express, { type Express } from 'express';
import type { Address } from '@solana/kit';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactSvmScheme as ServerScheme } from '@x402/svm/exact/server';

import { DEVNET } from './net.js';

export const REPORT_PRICE = '20000';

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
        'Lantern Row market note (fictional): orders for small hardware rose this week. Nothing here is real data.\n',
      );
  });
  return app;
}
