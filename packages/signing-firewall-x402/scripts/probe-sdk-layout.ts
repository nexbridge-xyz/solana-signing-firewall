// Builds x402 `exact` payments with the real @x402/svm client and prints the
// instructions it puts in each transaction version.
//
// Nothing leaves this machine: the client's RPC is a stub on 127.0.0.1 that only
// answers getAccountInfo for the mint, the blockhash comes from
// `extra.recentBlockhash`, and no transaction is sent anywhere.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type Address,
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getUtf8Decoder,
} from '@solana/kit';
import { getMintEncoder } from '@solana-program/token';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SPL_MEMO_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '@nexbridge/solana-signing-firewall';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const PROGRAM_LABELS = new Map<string, string>([
  [COMPUTE_BUDGET_PROGRAM_ADDRESS, 'ComputeBudget'],
  [TOKEN_PROGRAM_ADDRESS, 'SPL Token'],
  [TOKEN_2022_PROGRAM_ADDRESS, 'Token-2022'],
  [SPL_MEMO_PROGRAM_ADDRESS, 'SPL Memo'],
]);

const INSTRUCTION_NAMES = new Map<string, string>([
  ['ComputeBudget:2', 'SetComputeUnitLimit'],
  ['ComputeBudget:3', 'SetComputeUnitPrice'],
  ['SPL Token:12', 'TransferChecked'],
  ['SPL Token:13', 'ApproveChecked'],
]);

function startStubRpc(): Promise<{ url: string; close: () => void; methods: string[] }> {
  const mintData = getMintEncoder().encode({
    mintAuthority: null,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  });
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      methods.push(call.method);
      const result =
        call.method === 'getAccountInfo' && call.params[0] === MINT
          ? {
              context: { slot: 1 },
              value: {
                data: [Buffer.from(mintData).toString('base64'), 'base64'],
                executable: false,
                lamports: 1_461_600,
                owner: TOKEN_PROGRAM_ADDRESS,
                rentEpoch: 0,
                space: mintData.length,
              },
            }
          : null;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          result === null
            ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'stub: not served' } }
            : { jsonrpc: '2.0', id: call.id, result },
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), methods });
    });
  });
}

async function build(
  label: string,
  rpcUrl: string,
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  extra: Record<string, unknown>,
  clientVersions?: readonly (0 | 1)[],
): Promise<void> {
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: DEVNET,
    amount: '20000',
    asset: MINT,
    payTo: (await generateKeyPairSigner()).address,
    maxTimeoutSeconds: 60,
    extra,
  };
  const scheme = new ExactSvmScheme(
    payer,
    clientVersions === undefined ? { rpcUrl } : { rpcUrl, transactionVersions: clientVersions },
  );
  const { payload } = await scheme.createPaymentPayload(2, requirements);
  const wire = getBase64Encoder().encode((payload as { transaction: string }).transaction);
  const tx = getTransactionDecoder().decode(wire);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const accounts: Address[] = [...message.staticAccounts];

  console.log(`\n== ${label}`);
  console.log(`   message version: ${String(message.version)}`);
  if (message.version === 1) {
    const { configMask, configValues } = message as unknown as {
      configMask: number;
      configValues: { kind: string; value: number | bigint }[];
    };
    console.log(
      `   transactionConfig: mask=0b${configMask.toString(2)} values=${configValues
        .map((v) => `${v.kind}:${String(v.value)}`)
        .join(', ')}`,
    );
  }
  instructionsOf(message).forEach((ix, i) => {
    const program = accounts[ix.programIndex] ?? '?';
    const programLabel = PROGRAM_LABELS.get(program) ?? `other (${program})`;
    const name = INSTRUCTION_NAMES.get(`${programLabel}:${String(ix.data[0])}`) ?? '';
    const memo = programLabel === 'SPL Memo' ? ` text="${getUtf8Decoder().decode(ix.data)}"` : '';
    console.log(
      `   ix[${i}] ${programLabel} ${name} data=${ix.data.length}B accounts=${ix.accountIndices.length}${memo}`,
    );
  });
  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  console.log(`   required signers: ${signers.length} (fee payer first: ${String(signers[0])})`);
  console.log(`   blockhash used: ${message.lifetimeToken}`);
}

type FlatInstruction = {
  programIndex: number;
  accountIndices: readonly number[];
  data: Uint8Array;
};

function instructionsOf(
  message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>,
): FlatInstruction[] {
  if (message.version === 1) {
    return message.instructionHeaders.map((header, i) => {
      const payload = message.instructionPayloads[i];
      return {
        programIndex: header.programAccountIndex,
        accountIndices: payload?.instructionAccountIndices ?? [],
        data: new Uint8Array(payload?.instructionData ?? []),
      };
    });
  }
  return message.instructions.map((ix) => ({
    programIndex: ix.programAddressIndex,
    accountIndices: ix.accountIndices ?? [],
    data: new Uint8Array(ix.data ?? []),
  }));
}

const stub = await startStubRpc();
try {
  const payer = await generateKeyPairSigner();
  const feePayer = (await generateKeyPairSigner()).address;
  const recentBlockhash = getBase58Decoder().decode(new Uint8Array(32).fill(7));
  await build('facilitator advertises [0, 1], client default', stub.url, payer, {
    feePayer,
    recentBlockhash,
    transactionVersions: [0, 1],
  });
  await build('no transactionVersions in requirements (spec default [0])', stub.url, payer, {
    feePayer,
    recentBlockhash,
  });
  await build(
    'facilitator advertises [0, 1], client limited to [0]',
    stub.url,
    payer,
    {
      feePayer,
      recentBlockhash,
      transactionVersions: [0, 1],
    },
    [0],
  );
  await build('v1 with seller memo', stub.url, payer, {
    feePayer,
    recentBlockhash,
    transactionVersions: [0, 1],
    memo: 'invoice-0001',
  });
  console.log(
    `\nRPC methods the client called on the stub: ${[...new Set(stub.methods)].join(', ')}`,
  );
} finally {
  stub.close();
}
