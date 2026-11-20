// Builds x402 payments two ways: with the real @x402/svm client (made
// deterministic), and by hand with Kit for the attack-shaped vectors. Nothing is
// ever sent: the SDK's RPC is a stub on 127.0.0.1 and the blockhash is fixed.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type Address,
  type Instruction,
  type V1TransactionConfig,
  AccountRole,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Nonce,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getTransferCheckedInstruction } from '@solana-program/token';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import type { PaymentRequirements } from '@x402/core/types';

import { SPL_MEMO_PROGRAM_ADDRESS, type SnapshotAccount } from '@nexbridge/solana-signing-firewall';

import { FIXED_BLOCKHASH } from '../messages.js';
import type { X402World } from './world.js';

export const SDK_LIMIT = 20_000;
export const SDK_PRICE = 1n;
export const SDK_V1_CONFIG: V1TransactionConfig = {
  computeUnitLimit: 20_000,
  loadedAccountsDataSizeLimit: 4_194_304,
  priorityFeeLamports: 1n,
};

/** A fixed 16-byte nonce, hex-encoded, as the SDK formats its random one. */
export function nonceFor(label: string): string {
  return createHash('sha256').update(`x402 nonce ${label}`).digest('hex').slice(0, 32);
}

export function memoInstruction(text: string, accounts: Instruction['accounts'] = []): Instruction {
  return {
    programAddress: SPL_MEMO_PROGRAM_ADDRESS,
    accounts,
    data: new TextEncoder().encode(text),
  };
}

export function transferInstruction(
  w: X402World,
  options: {
    amount?: bigint;
    destination?: Address;
    source?: Address;
    authority?: X402World['agent'];
    mint?: Address;
  } = {},
) {
  return getTransferCheckedInstruction({
    source: options.source ?? w.agentAta,
    mint: options.mint ?? w.mint,
    destination: options.destination ?? w.shopAta,
    authority: options.authority ?? w.agent,
    amount: options.amount ?? 20_000n,
    decimals: 6,
  });
}

export function budgetInstructions(price = SDK_PRICE): Instruction[] {
  return [
    getSetComputeUnitLimitInstruction({ units: SDK_LIMIT }),
    getSetComputeUnitPriceInstruction({ microLamports: price }),
  ];
}

export type HandBuilt = {
  version: 0 | 1;
  instructions: Instruction[];
  feePayer?: Address;
  config?: V1TransactionConfig;
  lookupTables?: Record<Address, Address[]>;
  nonce?: { account: Address; authority: Address; value: string };
};

/** Compiles and partially signs (by every signer the instructions carry) a payment. Base64 wire bytes. */
export async function handBuilt(w: X402World, spec: HandBuilt): Promise<string> {
  const feePayer = spec.feePayer ?? w.feePayer.address;
  const blockhash = { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 0n };
  if (spec.version === 1) {
    const message = pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => setTransactionMessageConfig(spec.config ?? SDK_V1_CONFIG, m),
      (m) => appendTransactionMessageInstructions(spec.instructions, m),
    );
    return getBase64EncodedWireTransaction(
      await partiallySignTransactionMessageWithSigners(message),
    );
  }
  const base = pipe(createTransactionMessage({ version: 0 }), (m) =>
    setTransactionMessageFeePayer(feePayer, m),
  );
  const nonce = spec.nonce;
  if (nonce !== undefined) {
    const message = pipe(
      base,
      (m) =>
        setTransactionMessageLifetimeUsingDurableNonce(
          {
            nonce: nonce.value as Nonce,
            nonceAccountAddress: nonce.account,
            nonceAuthorityAddress: nonce.authority,
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions(spec.instructions, m),
    );
    return getBase64EncodedWireTransaction(
      await partiallySignTransactionMessageWithSigners(message),
    );
  }
  const message = pipe(
    base,
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(spec.instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, spec.lookupTables ?? {}),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

/** The SDK's default layout, built by hand: v0 budget, transfer, nonce memo; v1 transfer, nonce memo. */
export function sdkLayout(
  w: X402World,
  version: 0 | 1,
  label: string,
  transfer = transferInstruction(w),
): Instruction[] {
  return [
    ...(version === 0 ? budgetInstructions() : []),
    transfer,
    memoInstruction(nonceFor(label)),
  ];
}

/** A signer account to attach to an instruction, making it a required signer. */
export const signerMeta = (address: Address) => ({
  address,
  role: AccountRole.READONLY_SIGNER as const,
});

export { createNoopSigner };

// ---------------------------------------------------------------- the real SDK

export function startStubRpc(accounts: ReadonlyMap<Address, SnapshotAccount>) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const account =
        call.method === 'getAccountInfo' ? accounts.get(call.params[0] as Address) : undefined;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          account === undefined
            ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'stub: not served' } }
            : {
                jsonrpc: '2.0',
                id: call.id,
                result: {
                  context: { slot: 1 },
                  value: {
                    data: [Buffer.from(account.data).toString('base64'), 'base64'],
                    executable: account.executable,
                    lamports: Number(account.lamports),
                    owner: account.owner,
                    rentEpoch: 0,
                    space: account.data.length,
                  },
                },
              },
        ),
      );
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/**
 * Builds a payment with the real @x402/svm client. Its only randomness, the
 * 16-byte memo nonce, comes from a fixed seed while the call runs.
 */
export async function sdkBuilt(
  w: X402World,
  requirements: PaymentRequirements,
  accounts: ReadonlyMap<Address, SnapshotAccount>,
  seed: string,
): Promise<string> {
  const rpc = await startStubRpc(accounts);
  const fill = createHash('sha256').update(`x402 sdk nonce ${seed}`).digest();
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.set(fill.subarray(0, array.length));
      return array;
    },
  });
  try {
    const scheme = new ExactSvmScheme(w.agent, { rpcUrl: rpc.url });
    const { payload } = await scheme.createPaymentPayload(2, requirements);
    return (payload as { transaction: string }).transaction;
  } finally {
    delete (globalThis.crypto as { getRandomValues?: unknown }).getRandomValues;
    rpc.close();
  }
}
