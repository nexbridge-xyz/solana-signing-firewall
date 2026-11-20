// A JSON-RPC server on 127.0.0.1 backed by LiteSVM, serving only the methods the
// x402 SDK and the snapshot loader call. It lets scenes 12 to 15 run end to end,
// settlement included, without touching any cluster.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type Address,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  lamports,
} from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';

type NativeSvm = {
  setSigverify(sigverify: boolean): void;
  sendLegacyTransaction(bytes: Uint8Array): unknown;
  sendVersionedTransaction(bytes: Uint8Array): unknown;
  simulateLegacyTransaction(bytes: Uint8Array): unknown;
  simulateVersionedTransaction(bytes: Uint8Array): unknown;
};

export type LocalRpc = { url: string; svm: LiteSVM; close: () => Promise<void> };

function encodeAccount(svm: LiteSVM, address: Address) {
  const account = svm.getAccount(address);
  if (!account.exists) return null;
  return {
    data: [getBase64Decoder().decode(account.data), 'base64'],
    executable: account.executable,
    lamports: Number(account.lamports),
    owner: account.programAddress,
    rentEpoch: 0,
    space: account.data.length,
  };
}

function isLegacy(wire: Uint8Array): boolean {
  // The message follows the signatures; its first byte has the high bit set for v0 and v1.
  const count = wire[0] ?? 0;
  const first = wire[1 + count * 64];
  return wire[0] !== 0x81 && first !== undefined && first < 0x80;
}

export async function startLocalRpc(svm = new LiteSVM()): Promise<LocalRpc> {
  const native = (svm as unknown as { inner: NativeSvm }).inner;
  const landed = new Map<string, { slot: number; err: unknown }>();

  const methods: Record<string, (params: unknown[]) => unknown> = {
    getGenesisHash: () => 'LocaL1iteSVM1111111111111111111111111111111',
    getSlot: () => Number(svm.getClock().slot),
    getLatestBlockhash: () => ({
      value: {
        blockhash: svm.latestBlockhash(),
        lastValidBlockHeight: Number(svm.getClock().slot) + 150,
      },
    }),
    getAccountInfo: ([address]) => ({ value: encodeAccount(svm, address as Address) }),
    getMultipleAccounts: ([addresses]) => ({
      value: (addresses as Address[]).map((a) => encodeAccount(svm, a)),
    }),
    getBalance: ([address]) => ({ value: Number(svm.getBalance(address as Address) ?? 0n) }),
    getMinimumBalanceForRentExemption: ([size]) =>
      Number(svm.minimumBalanceForRentExemption(BigInt(size as number))),
    simulateTransaction: ([transaction, config]) => {
      const wire = new Uint8Array(getBase64Encoder().encode(transaction as string));
      // A facilitator simulates before it adds its own signature, with sigVerify off.
      const verify = (config as { sigVerify?: boolean } | undefined)?.sigVerify !== false;
      native.setSigverify(verify);
      const result = isLegacy(wire)
        ? native.simulateLegacyTransaction(wire)
        : native.simulateVersionedTransaction(wire);
      native.setSigverify(true);
      const failed = result instanceof FailedTransactionMetadata;
      return {
        value: {
          err: failed ? { message: result.toString() } : null,
          logs: [],
          accounts: null,
          unitsConsumed: 0,
          returnData: null,
        },
      };
    },
    sendTransaction: ([transaction]) => {
      const wire = new Uint8Array(getBase64Encoder().encode(transaction as string));
      const decoded = getTransactionDecoder().decode(wire);
      const first = Object.values(decoded.signatures)[0];
      if (first === null || first === undefined) throw new Error('unsigned transaction');
      const signature = getBase58Decoder().decode(first);
      const result = isLegacy(wire)
        ? native.sendLegacyTransaction(wire)
        : native.sendVersionedTransaction(wire);
      if (result instanceof FailedTransactionMetadata)
        throw new Error(`transaction failed: ${result.toString()}`);
      landed.set(signature, { slot: Number(svm.getClock().slot), err: null });
      svm.expireBlockhash();
      return signature;
    },
    getSignatureStatuses: ([signatures]) => ({
      value: (signatures as string[]).map((s) => {
        const status = landed.get(s);
        return status === undefined
          ? null
          : {
              slot: status.slot,
              confirmations: null,
              err: status.err,
              status: { Ok: null },
              confirmationStatus: 'finalized',
            };
      }),
    }),
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      const method = methods[call.method];
      let reply: unknown;
      try {
        if (method === undefined) throw new Error(`method not served: ${call.method}`);
        const result = method(call.params ?? []);
        const withContext =
          typeof result === 'object' && result !== null && 'value' in result
            ? { context: { slot: Number(svm.getClock().slot) }, ...result }
            : result;
        reply = { jsonrpc: '2.0', id: call.id, result: withContext };
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    svm,
    close: () => new Promise((resolve) => server.close(() => { resolve(); })),
  };
}

export { lamports };
