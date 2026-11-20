// Security review: the genesis-hash check comes before any write.
//
// setup, demo and recycle are pointed at an RPC that serves another cluster's genesis hash. The
// fake RPC listens on 127.0.0.1 and records every method it is asked for: each command must ask
// for the genesis hash and nothing else. No airdrop request, no blockhash, no transaction.
// Holds at the reviewed commit. (verify-run is a separate test: it made no such check.)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Cast,
  DEVNET_USDC_MINT,
  createCast,
  createDemoRpc,
  ensureKeys,
  loadKeyPairs,
  pathsIn,
  rpcUrlFrom,
} from '@nexbridge/example-demo-common';

import { runDemo, runRecycle, runSetup } from '../src/index.js';

const GENESIS = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  // Devnet's first 31 characters, then something else: the comparison is not a loose prefix.
  nearDevnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqaXwcaWoxPkrZBG',
} as const;

const dir = mkdtempSync(join(tmpdir(), 'review-wrong-cluster-'));
const paths = pathsIn(dir);
let cast: Cast;

beforeAll(async () => {
  await ensureKeys(paths, { requireGitIgnored: false });
  cast = await createCast(await loadKeyPairs(paths.env), DEVNET_USDC_MINT);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function fakeRpc(genesis: string) {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string };
      methods.push(call.method);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          call.method === 'getGenesisHash'
            ? { jsonrpc: '2.0', id: call.id, result: genesis }
            : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'not served' } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { url, rpc: createDemoRpc(url), methods, close: () => server.close() };
}

const log = () => undefined;

describe('demo commands against an RPC of another cluster', () => {
  it.each(Object.entries(GENESIS))(
    '%s: setup, demo and recycle ask for the genesis hash and nothing else',
    async (_cluster, genesis) => {
      const commands = {
        setup: (rpc: ReturnType<typeof createDemoRpc>) =>
          runSetup({ rpc, cast, network: 'devnet', setupStatePath: paths.setupState, log }),
        demo: (rpc: ReturnType<typeof createDemoRpc>, url: string) =>
          runDemo({
            rpc,
            rpcUrl: url,
            cast,
            network: 'devnet',
            paths,
            log,
            which: 'all',
            ports: { facilitator: 0, shop: 0, secondShop: 0 },
          }),
        recycle: (rpc: ReturnType<typeof createDemoRpc>) =>
          runRecycle({ rpc, cast, network: 'devnet', setupStatePath: paths.setupState, log }),
      };
      for (const [name, run] of Object.entries(commands)) {
        const server = await fakeRpc(genesis);
        try {
          await expect(run(server.rpc, server.url), name).rejects.toThrow(/genesis/);
          expect(server.methods, name).toEqual(['getGenesisHash']);
        } finally {
          server.close();
        }
      }
    },
  );

  it('a URL that names mainnet is refused before any request is made', () => {
    // rpcUrlFrom() reads the key file; these lines are all it needs.
    const envWith = (url: string) => {
      const file = join(dir, `env-${String(Math.random()).slice(2)}`);
      writeFileSync(file, `SOLANA_RPC_URL=${url}\n`);
      return file;
    };
    expect(() => rpcUrlFrom(envWith('https://api.mainnet-beta.solana.com'))).toThrow(/mainnet/);
    expect(() => rpcUrlFrom(envWith('https://MAINNET.example.org/key'))).toThrow(/mainnet/);
    // A mainnet endpoint whose URL does not say so passes this check; the genesis hash stops it.
    expect(rpcUrlFrom(envWith('https://rpc.example.org/abc'))).toBe('https://rpc.example.org/abc');
    expect(rpcUrlFrom(join(dir, 'no-such-file'))).toBe('https://api.devnet.solana.com');
  });
});
