// Security review helper, not a test: it reads devnet.
//
//   pnpm --filter @nexbridge/example-devnet-payouts exec tsx test/review-chain-vs-decision.script.ts
//
// `pnpm verify-run` compares the digest of each landed message with the recorded decision.
// This goes one step further and compares what the chain did with what the decision says
// review() reported, for every sent step of docs/devnet-run/run.json:
//   - the transaction succeeded;
//   - the fee is 5,000 lamports per required signature plus the reported priority fee;
//   - token balances changed by exactly the reviewed transfers, and no others;
//   - no lamports moved except the fee, paid by the reviewed fee payer.
// It checks the cluster's genesis hash first, sends nothing and needs no key.
import type { Signature } from '@solana/kit';

import { assertRpcNetwork } from '@nexbridge/solana-signing-firewall';
import {
  createDemoRpc,
  devnetPaths,
  readRunRecord,
  rpcUrlFrom,
} from '@nexbridge/example-demo-common';

type RecordedDecision = {
  feePayer: string;
  requiredSigners: string[];
  version: string;
  transfers: { source: string; destination: string; amount: string }[];
  fees: { priorityFeeLamports: string };
};

const paths = devnetPaths();
const rpc = createDemoRpc(rpcUrlFrom(paths.env));
await assertRpcNetwork(rpc, 'devnet');
const run = readRunRecord(paths.runRecord);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

let ok = 0;
let total = 0;
for (const scene of run.scenes) {
  for (const step of scene.steps) {
    if (step.signature === undefined || step.decision === undefined) continue;
    total += 1;
    const decision = step.decision as RecordedDecision;
    const found = await rpc
      .getTransaction(step.signature as Signature, {
        encoding: 'json',
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      })
      .send();
    if (found?.meta === null || found?.meta === undefined) {
      console.log(`scene ${String(scene.scene)}, ${step.label}: transaction not found`);
      continue;
    }
    const { meta } = found;
    const keys: string[] = [
      ...found.transaction.message.accountKeys,
      ...meta.loadedAddresses.writable,
      ...meta.loadedAddresses.readonly,
    ];

    const reported = new Map<string, bigint>();
    for (const t of decision.transfers) {
      reported.set(t.source, (reported.get(t.source) ?? 0n) - BigInt(t.amount));
      reported.set(t.destination, (reported.get(t.destination) ?? 0n) + BigInt(t.amount));
    }
    const moved = new Map<string, bigint>();
    for (const balance of meta.preTokenBalances ?? []) {
      const key = keys[balance.accountIndex] ?? '?';
      moved.set(key, (moved.get(key) ?? 0n) - BigInt(balance.uiTokenAmount.amount));
    }
    for (const balance of meta.postTokenBalances ?? []) {
      const key = keys[balance.accountIndex] ?? '?';
      moved.set(key, (moved.get(key) ?? 0n) + BigInt(balance.uiTokenAmount.amount));
    }
    for (const [key, delta] of [...moved]) if (delta === 0n) moved.delete(key);
    const tokensAsReported =
      reported.size === moved.size &&
      [...reported].every(([key, delta]) => moved.get(key) === delta);

    const reportedFee =
      5_000n * BigInt(decision.requiredSigners.length) + BigInt(decision.fees.priorityFeeLamports);
    const lamports = keys
      .map(
        (key, i) =>
          [key, BigInt(meta.postBalances[i] ?? 0n) - BigInt(meta.preBalances[i] ?? 0n)] as const,
      )
      .filter(([, delta]) => delta !== 0n);
    const onlyTheFee =
      lamports.length === 1 &&
      lamports[0]?.[0] === decision.feePayer &&
      lamports[0][1] === -BigInt(meta.fee);

    const good =
      meta.err === null &&
      tokensAsReported &&
      BigInt(meta.fee) === reportedFee &&
      onlyTheFee &&
      keys[0] === decision.feePayer;
    if (good) ok += 1;
    console.log(
      `scene ${String(scene.scene)} (${decision.version}), ${step.label}: ` +
        `${meta.err === null ? 'succeeded' : 'FAILED ON CHAIN'}, fee ${String(meta.fee)} ` +
        `(reported ${reportedFee.toString()}), tokens ${tokensAsReported ? 'as reported' : 'DIFFER'}, ` +
        `lamports ${onlyTheFee ? 'only the fee, from the fee payer' : 'OTHER CHANGES'} -> ${good ? 'ok' : 'MISMATCH'}`,
    );
    await sleep(700);
  }
}
console.log(
  `${String(ok)} of ${String(total)} sent transactions did on devnet exactly what the recorded decision reported`,
);
if (ok !== total || total === 0) process.exitCode = 1;
