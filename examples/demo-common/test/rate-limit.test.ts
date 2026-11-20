import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { retryRpcOnRateLimit } from '../src/index.js';

let calls: string[] = [];
let busy = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => {
    calls.push(body);
    if (busy > 0) {
      busy -= 1;
      res.statusCode = 429;
      res.end('Too Many Requests');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"jsonrpc":"2.0","id":1,"result":1}');
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
);

const post = (target: string, method: string) =>
  fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });

describe('retryRpcOnRateLimit', () => {
  it('sends the same request again after a 429, but never an airdrop request', async () => {
    const lines: string[] = [];
    const restore = retryRpcOnRateLimit(url, (line) => lines.push(line));
    try {
      calls = [];
      busy = 1;
      expect((await post(url, 'getSlot')).status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(calls[1]);
      expect(lines).toEqual([
        '  (the RPC answered 429 Too Many Requests; sending the same request again in 1 s)',
      ]);

      calls = [];
      busy = 1;
      expect((await post(url, 'requestAirdrop')).status).toBe(429);
      expect(calls).toHaveLength(1);

      calls = [];
      busy = 1;
      expect((await post(`${url}other`, 'getSlot')).status).toBe(429);
      expect(calls).toHaveLength(1);
    } finally {
      restore();
      busy = 0;
    }
    calls = [];
    busy = 1;
    expect((await post(url, 'getSlot')).status).toBe(429);
    busy = 0;
  }, 20_000);
});
