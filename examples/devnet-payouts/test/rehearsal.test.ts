// A full rehearsal of the devnet demo on this machine: fresh keys in a temporary
// key file, a LiteSVM-backed RPC on 127.0.0.1, then setup, scenes 1 to 15,
// verify-run, the README table and recycling. Nothing here reaches a cluster.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Cast,
  DEVNET_USDC_MINT,
  KEY_VARIABLES,
  type RunRecord,
  type SceneRecord,
  createCast,
  createDemoRpc,
  ensureKeys,
  loadKeyPairs,
  pathsIn,
  readEnv,
  readRunRecord,
} from '@nexbridge/example-demo-common';
import { type LocalRpc, startLocalRpc } from '@nexbridge/example-demo-common/local-rpc';

import {
  renderTable,
  runDemo,
  runRecycle,
  runSetup,
  seedLocalUsdc,
  tokenBalance,
  verifyRun,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'signing-firewall-rehearsal-'));
const paths = pathsIn(dir);
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
};
const hosts = new Set<string>();
const realFetch = globalThis.fetch;

let local: LocalRpc;
let cast: Cast;
let rpc: ReturnType<typeof createDemoRpc>;
let run: RunRecord;

beforeAll(async () => {
  // Every HTTP request this test makes must stay on this machine.
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    hosts.add(url.hostname);
    return realFetch(input, init);
  };
  expect(await ensureKeys(paths, { requireGitIgnored: false })).toHaveLength(8);
  cast = await createCast(await loadKeyPairs(paths.env), DEVNET_USDC_MINT);
  local = await startLocalRpc();
  rpc = createDemoRpc(local.url);
  // The USDC mint, and the 10 USDC a person requests from Circle's faucet for the treasury.
  seedLocalUsdc(local, cast, 10_000_000n);
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await local.close();
});

const scene = (n: number): SceneRecord => {
  const found = run.scenes.find((s) => s.scene === n);
  if (found === undefined) throw new Error(`scene ${String(n)} missing`);
  return found;
};
const codes = (n: number, step = 0) =>
  (scene(n).steps[step]?.reasons ?? []).map((r) => r.code).sort();

describe('devnet demo rehearsal on a local RPC', () => {
  it('runs setup, and a second setup sends nothing', async () => {
    const setup = await runSetup({
      rpc,
      cast,
      network: 'localnet',
      setupStatePath: paths.setupState,
      log,
    });
    expect(setup.lookupTable).toBeDefined();
    expect(setup.steps.every((s) => s.label === 'setup, not a scene')).toBe(true);
    expect(await tokenBalance(rpc, cast.agentAta)).toBe(100_000n);
    const again = await runSetup({
      rpc,
      cast,
      network: 'localnet',
      setupStatePath: paths.setupState,
      log,
    });
    expect(again.steps).toHaveLength(setup.steps.length);
  }, 120_000);

  it('runs scenes 1 to 15 with the expected outcomes', async () => {
    run = await runDemo({
      rpc,
      rpcUrl: local.url,
      cast,
      network: 'localnet',
      paths,
      log,
      which: 'all',
      ports: { facilitator: 0, shop: 0, secondShop: 0 },
    });
    expect(run.scenes.map((s) => s.scene)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);

    for (const n of [1, 2, 3, 4]) {
      expect(scene(n).steps[0]).toMatchObject({ outcome: 'allow', sent: true, signerCalls: 1 });
    }
    const scene2 = scene(2).steps[0]?.decision as { lookupTableEntries: unknown[] };
    expect(scene2.lookupTableEntries.length).toBeGreaterThan(0);
    const scene3 = scene(3).steps[0]?.decision as { fees: { source: string } };
    expect(scene3.fees.source).toBe('transactionConfig');

    expect(scene(5).steps).toHaveLength(2);
    expect(scene(5).steps[0]).toMatchObject({
      outcome: 'needs_approval',
      sent: false,
      signerCalls: 0,
    });
    expect(codes(5)).toEqual(['APPROVAL_REQUIRED']);
    expect(scene(5).steps[1]).toMatchObject({
      outcome: 'allow with approval',
      sent: true,
      signerCalls: 1,
    });

    const blocked: [number, string[]][] = [
      [6, ['APPROVAL_MESSAGE_MISMATCH']],
      [7, ['DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT', 'RECIPIENT_NOT_ALLOWED']],
      [8, ['PER_TRANSACTION_LIMIT_EXCEEDED']],
      [9, ['TOKEN_INSTRUCTION_NOT_ALLOWED']],
      [10, ['DURABLE_NONCE_NOT_ALLOWED']],
      [11, ['COMPUTE_BUDGET_INSTRUCTION_IN_V1', 'FEE_CAP_EXCEEDED']],
    ];
    for (const [n, expected] of blocked) {
      expect(codes(n), `scene ${String(n)}`).toEqual(expected);
      expect(scene(n).steps[0]).toMatchObject({ sent: false, signerCalls: 0 });
    }
    expect(scene(9).steps[0]?.reasons[0]?.path).toBe('ix[0].batch[1]');

    expect(scene(12).steps[0]).toMatchObject({ outcome: 'allow', sent: true, signerCalls: 1 });
    const options = scene(13).steps[0]?.quotes ?? [];
    expect(options.map((q) => q.reasons)).toEqual([
      ['X402_PAYTO_NOT_ALLOWED'],
      ['X402_FEE_PAYER_NOT_ALLOWED'],
      ['X402_ASSET_NOT_ALLOWED'],
      [],
    ]);
    expect(options[3]?.outcome).toMatch(/removed by the SDK/);
    expect(scene(13).steps[0]).toMatchObject({ outcome: 'deny', sent: false, signerCalls: 0 });
    expect(scene(14).steps[0]).toMatchObject({ outcome: 'allow', sent: true, signerCalls: 1 });
    expect(codes(14, 1)).toEqual(['X402_BUDGET_EXCEEDED']);
    expect(scene(14).steps[1]).toMatchObject({ sent: false, signerCalls: 0 });
    expect(codes(15)).toEqual(['X402_NOT_TRANSFER_CHECKED']);
    expect(scene(15).steps[0]).toMatchObject({ outcome: 'invalid', sent: false, signerCalls: 0 });

    // Exactly the reviewed transfers moved.
    expect(await tokenBalance(rpc, cast.vendorAAta)).toBe(1_900_000n);
    expect(await tokenBalance(rpc, cast.vendorBAta)).toBe(5_100_000n);
    expect(await tokenBalance(rpc, cast.outsiderPlainAccount)).toBe(0n);
    expect(await tokenBalance(rpc, cast.outsiderAta)).toBe(0n);
    expect(await tokenBalance(rpc, cast.shopAta)).toBe(40_000n);
    expect(await tokenBalance(rpc, cast.agentAta)).toBe(60_000n);
  }, 180_000);

  it('verifies every sent message against the reviewed bytes', async () => {
    expect(await verifyRun({ rpc, recordPath: paths.runRecord, log })).toEqual({
      matched: 7,
      total: 7,
    });
    expect(lines).toContain('7 of 7 on-chain messages match the reviewed bytes');
  }, 60_000);

  it('renders the README table', () => {
    const table = renderTable(readRunRecord(paths.runRecord));
    expect(table.split('\n').filter((l) => /^\| \d+ \|/.test(l))).toHaveLength(15);
    expect(table).toContain('`TOKEN_INSTRUCTION_NOT_ALLOWED` at `ix[0].batch[1]`');
  });

  it('recycles the vendors and the shop', async () => {
    await runRecycle({ rpc, cast, network: 'localnet', setupStatePath: paths.setupState, log });
    expect(await tokenBalance(rpc, cast.vendorAAta)).toBe(0n);
    expect(await tokenBalance(rpc, cast.vendorBAta)).toBe(0n);
    expect(await tokenBalance(rpc, cast.shopAta)).toBe(0n);
    expect(await tokenBalance(rpc, cast.treasuryAta)).toBe(9_940_000n);
  }, 60_000);

  it('stayed on this machine and never printed or recorded a key', () => {
    expect([...hosts]).toEqual(['127.0.0.1']);
    const env = readEnv(paths.env);
    const written = [
      lines.join('\n'),
      readFileSync(paths.runRecord, 'utf8'),
      readFileSync(paths.setupState, 'utf8'),
    ].join('\n');
    for (const variable of Object.values(KEY_VARIABLES)) {
      const secret = env.get(variable) ?? '';
      expect(secret.length).toBeGreaterThan(80);
      expect(written.includes(secret)).toBe(false);
    }
  });
});
