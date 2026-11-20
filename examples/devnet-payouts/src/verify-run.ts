// `pnpm verify-run`: fetches every sent transaction of the recorded run,
// recomputes the digest of its message bytes and compares it with the
// recorded decision. For x402 settlements the facilitator adds its signature,
// which must leave the message unchanged.
import { type Signature, getBase64Encoder, getTransactionDecoder } from '@solana/kit';

import { sha256Hex } from '@nexbridge/solana-signing-firewall';
import { type DemoRpc, type Log, readRunRecord } from '@nexbridge/example-demo-common';

export async function verifyRun(ctx: {
  readonly rpc: DemoRpc;
  readonly recordPath: string;
  readonly log: Log;
}): Promise<{ matched: number; total: number }> {
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
      const ok = digest === step.messageDigest;
      if (ok) matched += 1;
      ctx.log(
        `  scene ${String(scene.scene)}, ${step.label}: ${ok ? 'match' : 'MISMATCH'} (slot ${found.slot.toString()}, sha256 ${digest.slice(0, 12)}...)`,
      );
    }
  }
  ctx.log(`${String(matched)} of ${String(total)} on-chain messages match the reviewed bytes`);
  return { matched, total };
}
