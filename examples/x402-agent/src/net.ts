// Every local x402 server listens on 127.0.0.1 only. No tunnels, no public URLs.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

export { DEVNET_CAIP2 as DEVNET } from '@nexbridge/example-demo-common';

export const HOST = '127.0.0.1';
export const PORTS = { facilitator: 4020, shop: 4021, secondShop: 4022 } as const;

export type Running = { url: string; close: () => Promise<void> };

/** Starts an app on 127.0.0.1. Port 0 picks a free port (tests). */
export async function listen(app: Express, port: number): Promise<Running> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, HOST, () => {
      resolve(s);
    });
  });
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://${HOST}:${bound}`,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
