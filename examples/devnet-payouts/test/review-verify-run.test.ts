// Security review: `pnpm verify-run`.
//
// At the reviewed commit it asked whatever RPC SOLANA_RPC_URL names for the recorded
// transactions without first checking which cluster that RPC serves (every other demo command
// checks the genesis hash first), and it printed "match" for a transaction that failed on chain,
// because it compared only the message digest.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import {
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { sha256Hex } from '@nexbridge/solana-signing-firewall';
import { RUN_SCHEMA, createDemoRpc, writeJson } from '@nexbridge/example-demo-common';

import { verifyRun } from '../src/index.js';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const dir = mkdtempSync(join(tmpdir(), 'review-verify-run-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A JSON-RPC server on 127.0.0.1 that records the methods it is asked for. */
async function fakeRpc(answers: Record<string, unknown>) {
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
          call.method in answers
            ? { jsonrpc: '2.0', id: call.id, result: answers[call.method] }
            : { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'not served' } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    rpc: createDemoRpc(`http://127.0.0.1:${String(port)}`),
    methods,
    close: () => server.close(),
  };
}

/** A run record with one sent step, and the wire bytes a cluster would return for it. */
async function recordedStep() {
  const payer = await generateKeyPairSigner();
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(7)) as Blockhash,
            lastValidBlockHeight: 0n,
          },
          m,
        ),
    ),
  );
  const signature = getBase58Decoder().decode(new Uint8Array(64).fill(9));
  const recordPath = join(dir, `run-${String(Math.random()).slice(2)}.json`);
  writeJson(recordPath, {
    schema: RUN_SCHEMA,
    network: 'devnet',
    scenes: [
      {
        scene: 1,
        title: 'one transfer',
        expected: 'allow',
        vectors: [],
        steps: [
          {
            label: 'review, sign and send',
            outcome: 'allow',
            reasons: [],
            messageDigest: sha256Hex(new Uint8Array(transaction.messageBytes)),
            signerCalls: 1,
            sent: true,
            signature,
          },
        ],
      },
    ],
  });
  return { recordPath, wire: getBase64EncodedWireTransaction(transaction) };
}

const landed = (wire: string, err: unknown) => ({
  slot: 5,
  blockTime: null,
  version: 0,
  transaction: [wire, 'base64'],
  meta: { err, status: err === null ? { Ok: null } : { Err: err }, fee: 5000 },
});

describe('verify-run', () => {
  it('asks an RPC of another cluster for nothing but its genesis hash', async () => {
    const { recordPath, wire } = await recordedStep();
    const server = await fakeRpc({
      getGenesisHash: MAINNET_GENESIS,
      getTransaction: landed(wire, null),
    });
    try {
      const lines: string[] = [];
      await expect(
        verifyRun({ rpc: server.rpc, network: 'devnet', recordPath, log: (l) => lines.push(l) }),
      ).rejects.toThrow(/genesis/);
      expect(server.methods).toEqual(['getGenesisHash']);
      expect(lines.join('\n')).not.toContain('match');
    } finally {
      server.close();
    }
  });

  it('counts a transaction whose message matches and that succeeded (control)', async () => {
    const { recordPath, wire } = await recordedStep();
    const server = await fakeRpc({
      getGenesisHash: DEVNET_GENESIS,
      getTransaction: landed(wire, null),
    });
    try {
      const result = await verifyRun({
        rpc: server.rpc,
        network: 'devnet',
        recordPath,
        log: () => undefined,
      });
      expect(result).toEqual({ matched: 1, total: 1 });
    } finally {
      server.close();
    }
  });

  it('does not count a transaction that failed on chain as a match', async () => {
    const { recordPath, wire } = await recordedStep();
    const server = await fakeRpc({
      getGenesisHash: DEVNET_GENESIS,
      getTransaction: landed(wire, { InstructionError: [0, { Custom: 1 }] }),
    });
    try {
      const lines: string[] = [];
      const result = await verifyRun({
        rpc: server.rpc,
        network: 'devnet',
        recordPath,
        log: (l) => lines.push(l),
      });
      expect(result).toEqual({ matched: 0, total: 1 });
      expect(lines.join('\n')).toMatch(/failed on chain/i);
    } finally {
      server.close();
    }
  });
});
