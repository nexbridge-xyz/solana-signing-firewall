// `pnpm demo:rehearse`: the whole devnet demo against a LiteSVM-backed RPC on
// 127.0.0.1, with throwaway keys in a temporary directory that is deleted at
// the end. No cluster, no faucet, no network: it shows what the devnet run will
// print, and it is what the rehearsal test runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, lamports } from '@solana/kit';
import { AccountState, getMintEncoder, getTokenEncoder } from '@solana-program/token';

import { TOKEN_PROGRAM_ADDRESS } from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  DEVNET_USDC_MINT,
  type Log,
  createCast,
  createDemoRpc,
  ensureKeys,
  loadKeyPairs,
  pathsIn,
} from '@nexbridge/example-demo-common';
import { type LocalRpc, startLocalRpc } from '@nexbridge/example-demo-common/local-rpc';

import { runDemo } from './demo.js';
import { runRecycle } from './recycle.js';
import { runSetup } from './setup.js';
import { renderTable } from './table.js';
import { verifyRun } from './verify-run.js';

function setAccount(local: LocalRpc, address: Address, data: Uint8Array) {
  local.svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(local.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
}

/** Puts the USDC mint and the treasury's faucet USDC into the local ledger. */
export function seedLocalUsdc(local: LocalRpc, cast: Cast, treasuryUsdc: bigint): void {
  setAccount(
    local,
    DEVNET_USDC_MINT,
    new Uint8Array(
      getMintEncoder().encode({
        mintAuthority: cast.outsider,
        supply: 1_000_000_000_000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthority: null,
      }),
    ),
  );
  setAccount(
    local,
    cast.treasuryAta,
    new Uint8Array(
      getTokenEncoder().encode({
        mint: DEVNET_USDC_MINT,
        owner: cast.treasury,
        amount: treasuryUsdc,
        delegate: null,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: 0n,
        closeAuthority: null,
      }),
    ),
  );
}

export async function rehearse(log: Log): Promise<{ matched: number; total: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'signing-firewall-rehearsal-'));
  const local = await startLocalRpc();
  try {
    const paths = pathsIn(dir);
    await ensureKeys(paths, { requireGitIgnored: false });
    const cast = await createCast(await loadKeyPairs(paths.env), DEVNET_USDC_MINT);
    seedLocalUsdc(local, cast, 10_000_000n);
    const rpc = createDemoRpc(local.url);
    log('Rehearsal on a LiteSVM-backed RPC at 127.0.0.1, with throwaway keys. No cluster is used.');
    log('The treasury starts with 10.00 USDC, as if a person had requested it from a faucet.');
    log('');
    await runSetup({ rpc, cast, network: 'localnet', setupStatePath: paths.setupState, log });
    log('');
    const run = await runDemo({
      rpc,
      rpcUrl: local.url,
      cast,
      network: 'localnet',
      paths,
      log,
      which: 'all',
      ports: { facilitator: 0, shop: 0, secondShop: 0 },
    });
    log('');
    const verified = await verifyRun({ rpc, recordPath: paths.runRecord, log });
    log('');
    log(renderTable(run));
    await runRecycle({ rpc, cast, network: 'localnet', setupStatePath: paths.setupState, log });
    return verified;
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
