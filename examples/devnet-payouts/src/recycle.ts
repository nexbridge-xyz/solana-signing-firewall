// `pnpm demo:recycle`: sends the vendors' and the shop's USDC back to the
// treasury. The keys are ours; the treasury pays the fee. Not a scene.
import {
  type Instruction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferCheckedInstruction } from '@solana-program/token';

import { assertRpcNetwork } from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  type DemoNetwork,
  type DemoRpc,
  type Log,
  explorerFor,
  readSetupRecord,
  sendAndConfirm,
  setupSigner,
  shownLink,
  usdc,
  writeJson,
} from '@nexbridge/example-demo-common';

import { tokenBalance } from './setup.js';

export async function runRecycle(ctx: {
  readonly rpc: DemoRpc;
  readonly cast: Cast;
  readonly network: DemoNetwork;
  readonly setupStatePath: string;
  readonly log: Log;
}): Promise<string | undefined> {
  const { rpc, cast, log } = ctx;
  await assertRpcNetwork(rpc, ctx.network);
  const payer = await setupSigner(cast, 'treasury');
  const instructions: Instruction[] = [];
  let total = 0n;
  for (const [role, ata] of [
    ['vendorA', cast.vendorAAta],
    ['vendorB', cast.vendorBAta],
    ['shop', cast.shopAta],
  ] as const) {
    const amount = await tokenBalance(rpc, ata);
    if (amount === 0n) continue;
    total += amount;
    instructions.push(
      getTransferCheckedInstruction({
        source: ata,
        mint: cast.mint,
        destination: cast.treasuryAta,
        authority: await setupSigner(cast, role),
        amount,
        decimals: 6,
      }),
    );
  }
  if (instructions.length === 0) {
    log('Nothing to recycle.');
    return undefined;
  }
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const { signature, slot } = await sendAndConfirm(
    rpc,
    await signTransactionMessageWithSigners(message),
  );
  const record = readSetupRecord(ctx.setupStatePath);
  record.steps.push({
    step: `recycled ${usdc(total)} USDC from the vendors and the shop to the treasury`,
    label: 'recycle, not a scene',
    signature,
    slot: slot.toString(),
    ...explorerFor(ctx.network, signature),
  });
  writeJson(ctx.setupStatePath, record);
  log(
    `Recycled ${usdc(total)} USDC to the treasury (recycle, not a scene): ${shownLink(ctx.network, signature)}`,
  );
  return signature;
}
