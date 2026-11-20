// Entry point for the pnpm demo scripts. Devnet only: the RPC must serve
// devnet's genesis hash, and a URL naming mainnet is refused before any request.
// Keys are read from .env and never printed.
import { writeFileSync } from 'node:fs';

import {
  DEVNET_USDC_MINT,
  type Log,
  castTable,
  createCast,
  createDemoRpc,
  devnetPaths,
  ensureKeys,
  loadKeyPairs,
  readRunRecord,
  rpcUrlFrom,
} from '@nexbridge/example-demo-common';

import { runDemo, runRecordPath } from './demo.js';
import { runRecycle } from './recycle.js';
import { rehearse } from './rehearse.js';
import { SetupStopped, runSetup } from './setup.js';
import { renderTable } from './table.js';
import { verifyRun } from './verify-run.js';

const log: Log = (line) => {
  process.stdout.write(`${line}\n`);
};
const paths = devnetPaths();

async function devnet() {
  const cast = await createCast(await loadKeyPairs(paths.env), DEVNET_USDC_MINT);
  const rpcUrl = rpcUrlFrom(paths.env);
  return { cast, rpcUrl, rpc: createDemoRpc(rpcUrl) };
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case 'keys': {
      const created = await ensureKeys(paths);
      log(
        created.length === 0
          ? 'Every demo key already exists in .env (keys are never printed).'
          : `Generated ${String(created.length)} keys into .env (keys are never printed): ${created.join(', ')}.`,
      );
      const cast = await createCast(await loadKeyPairs(paths.env), DEVNET_USDC_MINT);
      log('Public addresses (all names are fictional):');
      for (const row of castTable(cast)) log(`  ${row.name.padEnd(34)} ${row.address}`);
      log('');
      log(`Treasury address for devnet USDC (faucet.circle.com, Solana Devnet): ${cast.treasury}`);
      return;
    }
    case 'setup': {
      const { cast, rpc } = await devnet();
      await runSetup({ rpc, cast, network: 'devnet', setupStatePath: paths.setupState, log });
      return;
    }
    case 'demo':
    case 'demo-x402': {
      const { cast, rpc, rpcUrl } = await devnet();
      await runDemo({
        rpc,
        rpcUrl,
        cast,
        network: 'devnet',
        paths,
        log,
        which: command === 'demo' ? 'all' : 'x402',
      });
      return;
    }
    case 'record': {
      const table = renderTable(readRunRecord(paths.runRecord));
      writeFileSync(paths.table, table);
      log(table);
      log(`Written to ${paths.table}`);
      return;
    }
    case 'verify-run': {
      const { rpc } = await devnet();
      const which = process.argv.includes('--x402') ? 'x402' : 'all';
      const { matched, total } = await verifyRun({
        rpc,
        recordPath: runRecordPath(paths, which),
        log,
      });
      if (matched !== total || total === 0) process.exitCode = 1;
      return;
    }
    case 'recycle': {
      const { cast, rpc } = await devnet();
      await runRecycle({ rpc, cast, network: 'devnet', setupStatePath: paths.setupState, log });
      return;
    }
    case 'rehearse': {
      const { matched, total } = await rehearse(log);
      if (matched !== total || total === 0) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(
        'usage: cli.ts keys | setup | demo | demo-x402 | record | verify-run [--x402] | recycle | rehearse',
      );
  }
}

main(process.argv[2]).catch((error: unknown) => {
  // Only the message: no stack, no request details.
  log(
    error instanceof SetupStopped
      ? `Stopped: ${error.message}`
      : `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = error instanceof SetupStopped ? 2 : 1;
});
