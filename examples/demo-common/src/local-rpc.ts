// A JSON-RPC server on 127.0.0.1 backed by LiteSVM. It serves only the methods
// the demo, the x402 SDK and the snapshot loader call, so the whole demo
// (setup, scenes 1 to 15 with settlement, verify-run) can be rehearsed on this
// machine without touching any cluster. Each landed transaction advances the
// slot by one and replaces the blockhash, roughly as a cluster would.
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

/** Stands in for a genesis hash; matches no cluster, so only `localnet` policies accept it. */
export const LOCAL_GENESIS_HASH = 'LocaL1iteSVM1111111111111111111111111111111';

export type LocalRpc = {
  url: string;
  svm: LiteSVM;
  /** Every method called, in order: rehearsals check what was asked for. */
  calls: string[];
  close: () => Promise<void>;
};

type Landed = { slot: bigint; wire: string | undefined; version: 'legacy' | 0 | 1 };

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

/** Legacy, 0 or 1, read from the wire bytes (version 1 starts with 0x81). */
function versionOf(wire: Uint8Array): 'legacy' | 0 | 1 {
  if (wire[0] === 0x81) return 1;
  const count = wire[0] ?? 0;
  const first = wire[1 + count * 64];
  return first !== undefined && first >= 0x80 ? 0 : 'legacy';
}

function randomSignature(): string {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
}

export async function startLocalRpc(svm = new LiteSVM()): Promise<LocalRpc> {
  const native = (svm as unknown as { inner: NativeSvm }).inner;
  const landed = new Map<string, Landed>();
  const calls: string[] = [];
  const slot = () => svm.getClock().slot;

  /** Ends the current slot: records it in SlotHashes (newest first), then moves on. */
  function nextSlot() {
    const ended = slot();
    const older = svm
      .getSlotHashes()
      .map((h) => ({ slot: h.slot, hash: h.hash }))
      .filter((h) => h.slot !== ended);
    svm.setSlotHashes([{ slot: ended, hash: svm.latestBlockhash() }, ...older].slice(0, 512));
    svm.warpToSlot(ended + 1n);
    svm.expireBlockhash();
  }

  function land(signature: string, wire: string | undefined, version: Landed['version']) {
    landed.set(signature, { slot: slot(), wire, version });
    nextSlot();
  }

  // Start with one ended slot, so a "finalized" slot exists in SlotHashes.
  nextSlot();

  const methods: Record<string, (params: unknown[]) => unknown> = {
    getGenesisHash: () => LOCAL_GENESIS_HASH,
    // "finalized" (also the default when no commitment is sent) lags one slot behind.
    getSlot: ([config]) => {
      const commitment = (config as { commitment?: string } | undefined)?.commitment;
      return Number(commitment === undefined || commitment === 'finalized' ? slot() - 1n : slot());
    },
    getLatestBlockhash: () => ({
      value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(slot()) + 150 },
    }),
    getAccountInfo: ([address]) => ({ value: encodeAccount(svm, address as Address) }),
    getMultipleAccounts: ([addresses]) => ({
      value: (addresses as Address[]).map((a) => encodeAccount(svm, a)),
    }),
    getBalance: ([address]) => ({ value: Number(svm.getBalance(address as Address) ?? 0n) }),
    getMinimumBalanceForRentExemption: ([size]) =>
      Number(svm.minimumBalanceForRentExemption(BigInt(size as number))),
    requestAirdrop: ([address, amount]) => {
      const result = svm.airdrop(address as Address, lamports(BigInt(amount as number)));
      if (result instanceof FailedTransactionMetadata) throw new Error('airdrop failed');
      const signature = randomSignature();
      land(signature, undefined, 'legacy');
      return signature;
    },
    simulateTransaction: ([transaction, config]) => {
      const wire = new Uint8Array(getBase64Encoder().encode(transaction as string));
      // A facilitator simulates before it adds its own signature, with sigVerify off.
      native.setSigverify((config as { sigVerify?: boolean } | undefined)?.sigVerify !== false);
      const result =
        versionOf(wire) === 'legacy'
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
      const base64 = transaction as string;
      const wire = new Uint8Array(getBase64Encoder().encode(base64));
      const decoded = getTransactionDecoder().decode(wire);
      const first = Object.values(decoded.signatures)[0];
      if (first === null || first === undefined) throw new Error('unsigned transaction');
      const signature = getBase58Decoder().decode(first);
      const version = versionOf(wire);
      const result =
        version === 'legacy'
          ? native.sendLegacyTransaction(wire)
          : native.sendVersionedTransaction(wire);
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`transaction failed: ${result.toString()}`);
      }
      land(signature, base64, version);
      return signature;
    },
    getSignatureStatuses: ([signatures]) => ({
      value: (signatures as string[]).map((s) => {
        const status = landed.get(s);
        return status === undefined
          ? null
          : {
              slot: Number(status.slot),
              confirmations: null,
              err: null,
              status: { Ok: null },
              confirmationStatus: 'finalized',
            };
      }),
    }),
    getTransaction: ([signature]) => {
      const status = landed.get(signature as string);
      if (status?.wire === undefined) return null;
      return {
        slot: Number(status.slot),
        blockTime: null,
        version: status.version,
        transaction: [status.wire, 'base64'],
        meta: { err: null, status: { Ok: null }, fee: 5000 },
      };
    },
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      calls.push(call.method);
      const method = methods[call.method];
      let reply: unknown;
      try {
        if (method === undefined) throw new Error(`method not served: ${call.method}`);
        const result = method(call.params ?? []);
        const withContext =
          typeof result === 'object' && result !== null && 'value' in result
            ? { context: { slot: Number(slot()) }, ...result }
            : result;
        reply = { jsonrpc: '2.0', id: call.id, result: withContext };
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    svm,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
