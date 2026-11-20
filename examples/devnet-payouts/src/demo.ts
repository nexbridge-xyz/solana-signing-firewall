// `pnpm demo` (scenes 1 to 15) and `pnpm demo:x402` (scenes 12 to 15). Writes
// the policies it used and the run record; prints every scene.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Address } from '@solana/kit';

import {
  assertRpcNetwork,
  canonicalDigest,
  parsePolicy,
  parseVerifierConfig,
  policyDigest,
} from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  type DemoNetwork,
  type DemoPaths,
  type DemoRpc,
  type Log,
  RUN_SCHEMA,
  type RunRecord,
  SIGNER_LABEL,
  type SceneRecord,
  type SetupRecord,
  agentPolicyJson,
  castTable,
  payoutsPolicyJson,
  readSetupRecord,
  shortDigest,
  usdc,
  verifierConfigJson,
  writeJson,
} from '@nexbridge/example-demo-common';
import { runX402Scenes } from '@nexbridge/example-x402-agent';

import { runPayoutScenes } from './scenes.js';
import { AMOUNTS, SetupStopped, solBalance, tokenBalance } from './setup.js';

export type DemoContext = {
  readonly rpc: DemoRpc;
  readonly rpcUrl: string;
  readonly cast: Cast;
  readonly network: DemoNetwork;
  readonly paths: DemoPaths;
  readonly log: Log;
  readonly which: 'all' | 'x402';
  readonly ports?: {
    readonly facilitator: number;
    readonly shop: number;
    readonly secondShop: number;
  };
  readonly now?: () => Date;
};

export const runRecordPath = (paths: DemoPaths, which: 'all' | 'x402') =>
  which === 'all' ? paths.runRecord : paths.runRecord.replace(/\.json$/, '-x402.json');

type Tracked = { account: string; address: Address; asset: 'SOL' | 'USDC' };

async function balances(rpc: DemoRpc, tracked: Tracked[]): Promise<bigint[]> {
  return Promise.all(
    tracked.map((t) =>
      t.asset === 'SOL' ? solBalance(rpc, t.address) : tokenBalance(rpc, t.address),
    ),
  );
}

export async function runDemo(ctx: DemoContext): Promise<RunRecord> {
  const { rpc, cast, network, paths, log } = ctx;
  await assertRpcNetwork(rpc, network);
  let setup: SetupRecord;
  try {
    setup = readSetupRecord(paths.setupState);
  } catch {
    throw new SetupStopped('No setup record found. Run pnpm demo:setup first.');
  }
  if (setup.lookupTable === undefined || setup.lookupTableEntries === undefined) {
    throw new SetupStopped('Setup has not created the lookup table yet. Run pnpm demo:setup.');
  }

  const needs: [string, bigint, bigint][] = [
    ['treasury SOL (lamports)', await solBalance(rpc, cast.treasury), 10_000_000n],
    [
      'facilitator fee payer SOL (lamports)',
      await solBalance(rpc, cast.facilitatorFeePayer),
      5_000_000n,
    ],
    ['agent USDC (base units)', await tokenBalance(rpc, cast.agentAta), 40_000n],
  ];
  if (ctx.which === 'all') {
    needs.push([
      'treasury USDC (base units)',
      await tokenBalance(rpc, cast.treasuryAta),
      AMOUNTS.scenesUsdc,
    ]);
  }
  const short = needs.filter(([, has, needed]) => has < needed);
  if (short.length > 0) {
    throw new SetupStopped(
      `Not enough funds: ${short.map(([what, has, needed]) => `${what} ${has.toString()} < ${needed.toString()}`).join('; ')}. Run pnpm demo:setup (it tops up from the treasury).`,
    );
  }

  const payoutsJson = payoutsPolicyJson(cast, network);
  const agentJson = agentPolicyJson(cast, network);
  const verifierJson = verifierConfigJson(cast);
  const payouts = parsePolicy(payoutsJson);
  const agent = parsePolicy(agentJson);
  const verifier = parseVerifierConfig(verifierJson);
  const files = {
    payouts: join(paths.policyDir, 'demo-payouts.json'),
    agent: join(paths.policyDir, 'demo-agent.json'),
    verifier: join(paths.policyDir, 'demo-facilitator-verifier.json'),
  };
  writeJson(files.payouts, payoutsJson);
  writeJson(files.agent, agentJson);
  writeJson(files.verifier, verifierJson);

  const tracked: Tracked[] = [
    { account: 'treasury', address: cast.treasury, asset: 'SOL' },
    { account: 'treasury', address: cast.treasuryAta, asset: 'USDC' },
    { account: 'vendor A', address: cast.vendorAAta, asset: 'USDC' },
    { account: 'vendor B', address: cast.vendorBAta, asset: 'USDC' },
    { account: 'outsider', address: cast.outsiderAta, asset: 'USDC' },
    { account: 'outsider (not associated)', address: cast.outsiderPlainAccount, asset: 'USDC' },
    { account: 'agent', address: cast.agentAta, asset: 'USDC' },
    { account: 'shop', address: cast.shopAta, asset: 'USDC' },
    { account: 'facilitator fee payer', address: cast.facilitatorFeePayer, asset: 'SOL' },
  ];
  const before = await balances(rpc, tracked);
  const startedAt = (ctx.now?.() ?? new Date()).toISOString();

  log(
    `Signing Firewall for Solana: ${ctx.which === 'all' ? 'scenes 1 to 15' : 'scenes 12 to 15'} on ${network}`,
  );
  log(`Signer: ${SIGNER_LABEL}`);
  log(
    `Policy ${payouts.policyId} ${shortDigest(policyDigest(payouts))}, policy ${agent.policyId} ${shortDigest(policyDigest(agent))}`,
  );

  const scenes: SceneRecord[] = [];
  if (ctx.which === 'all') {
    scenes.push(
      ...(await runPayoutScenes({
        rpc,
        network,
        cast,
        policy: payouts,
        lookupTable: setup.lookupTable as Address,
        lookupTableEntries: setup.lookupTableEntries as Address[],
        log,
        ...(ctx.now === undefined ? {} : { now: ctx.now }),
      })),
    );
  }
  const runId = startedAt.replace(/[:.]/g, '-');
  mkdirSync(paths.ledgerDir, { recursive: true });
  scenes.push(
    ...(await runX402Scenes({
      rpc,
      rpcUrl: ctx.rpcUrl,
      cast,
      network,
      agentPolicy: agent,
      verifierConfig: verifier,
      // A fresh budget file per run, so every recorded run starts from the same budget.
      ledgerPath: join(paths.ledgerDir, `budget-${runId}.json`),
      log,
      ...(ctx.ports === undefined ? {} : { ports: ctx.ports }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    })),
  );

  const after = await balances(rpc, tracked);
  const record: RunRecord = {
    schema: RUN_SCHEMA,
    network,
    startedAt,
    finishedAt: (ctx.now?.() ?? new Date()).toISOString(),
    signer: SIGNER_LABEL,
    cast: castTable(cast),
    policies: [
      {
        policyId: payouts.policyId,
        digest: policyDigest(payouts),
        file: 'policies/demo-payouts.json',
      },
      { policyId: agent.policyId, digest: policyDigest(agent), file: 'policies/demo-agent.json' },
      {
        policyId: 'demo-facilitator-verifier',
        digest: canonicalDigest(verifierJson),
        file: 'policies/demo-facilitator-verifier.json',
      },
    ],
    scenes,
    balances: tracked.map((t, i) => ({
      account: t.account,
      asset: t.asset,
      before: (before[i] ?? 0n).toString(),
      after: (after[i] ?? 0n).toString(),
    })),
  };
  writeJson(runRecordPath(paths, ctx.which), record);

  const sent = scenes.flatMap((s) => s.steps).filter((s) => s.sent).length;
  log('');
  log(
    `${String(scenes.length)} scenes, ${String(sent)} transactions sent. Blocked scenes were never sent.`,
  );
  const usdcMoved = (before[1] ?? 0n) - (after[1] ?? 0n);
  const solSpent = (before[0] ?? 0n) - (after[0] ?? 0n);
  log(`Treasury: ${usdc(usdcMoved)} USDC paid out, ${solSpent.toString()} lamports in fees.`);
  log('Next: pnpm verify-run');
  return record;
}
