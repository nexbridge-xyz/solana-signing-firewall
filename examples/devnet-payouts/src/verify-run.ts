// `pnpm verify-run`: fetches every sent transaction of the recorded run,
// recomputes the digest of its message bytes and compares it with the
// recorded decision, and checks that the transaction succeeded. For x402
// settlements the facilitator adds its signature, which must leave the message
// unchanged. It reads public chain data only and needs no key.
import { type Signature, getBase64Encoder, getTransactionDecoder } from '@solana/kit';

import { assertRpcNetwork, sha256Hex } from '@nexbridge/solana-signing-firewall';
import {
  type DemoNetwork,
  type DemoRpc,
  type Log,
  jsonWithBigInts,
  readRunRecord,
} from '@nexbridge/example-demo-common';

export async function verifyRun(ctx: {
  readonly rpc: DemoRpc;
  /** The cluster the RPC must serve. Checked before anything else is asked of it. */
  readonly network: DemoNetwork;
  readonly recordPath: string;
  readonly log: Log;
}): Promise<{ matched: number; total: number }> {
  await assertRpcNetwork(ctx.rpc, ctx.network);
  const run = readRunRecord(ctx.recordPath);
  let matched = 0;
  let total = 0;
  for (const scene of run.scenes) {
    for (const step of scene.steps) {
      if (step.signature === undefined || step.messageDigest === undefined) continue;
      total += 1;
      const found = await ctx.rpc
        .getTransaction(step.signature as Signature, {
          encoding: 'base64',
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed',
        })
        .send();
      if (found === null) {
        ctx.log(`  scene ${String(scene.scene)}, ${step.label}: transaction not found`);
        continue;
      }
      const wire = getBase64Encoder().encode(found.transaction[0]);
      const digest = sha256Hex(new Uint8Array(getTransactionDecoder().decode(wire).messageBytes));
      // The same bytes can land and fail (a frozen account, an empty one): that is no match.
      const failure = found.meta?.err ?? null;
      const ok = digest === step.messageDigest && failure === null;
      if (ok) matched += 1;
      const verdict =
        digest !== step.messageDigest
          ? 'MISMATCH'
          : failure === null
            ? 'match'
            : `FAILED ON CHAIN ${jsonWithBigInts(failure)}`;
      ctx.log(
        `  scene ${String(scene.scene)}, ${step.label}: ${verdict} (slot ${found.slot.toString()}, sha256 ${digest.slice(0, 12)}...)`,
      );
    }
  }
  ctx.log(`${String(matched)} of ${String(total)} on-chain messages match the reviewed bytes`);
  return { matched, total };
}
