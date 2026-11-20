// `pnpm demo:setup`: the accounts both demos need (docs/devnet-run/README.md). Every
// transaction here is signed with the unwrapped setup key and recorded as
// "setup, not a scene". Setup can run again: it skips what already exists and
// tops the agent up to 0.10 USDC.
import { existsSync } from 'node:fs';

import {
  type Address,
  type Instruction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  fetchMaybeAddressLookupTable,
  findAddressLookupTablePda,
  getCreateLookupTableInstructionAsync,
  getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import {
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
  getTransferSolInstruction,
} from '@solana-program/system';
import {
  fetchMaybeMint,
  fetchMaybeToken,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
  getTokenSize,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import {
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  assertRpcNetwork,
} from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  type DemoNetwork,
  type DemoRpc,
  type Log,
  NONCE_ACCOUNT_SEED,
  PLAIN_ACCOUNT_SEED,
  SETUP_SCHEMA,
  type SetupRecord,
  explorerFor,
  readSetupRecord,
  sendAndConfirm,
  setupSigner,
  shownLink,
  usdc,
  waitForConfirmation,
  writeJson,
} from '@nexbridge/example-demo-common';

/** Amounts, in base units. docs/devnet-run/README.md and the setup plan quote them. */
export const AMOUNTS = {
  /** One airdrop request for the treasury, only if it holds less than `treasuryMinLamports`. */
  airdropLamports: 1_000_000_000n,
  treasuryMinLamports: 200_000_000n,
  /** SOL the treasury sends the local facilitator's fee payer, if it holds less than the minimum. */
  facilitatorFundingLamports: 50_000_000n,
  facilitatorMinLamports: 20_000_000n,
  /** USDC the agent holds after setup ("setup, not a scene"). */
  agentUsdc: 100_000n,
  /** USDC scenes 1 to 5 move from the treasury to the vendors. */
  scenesUsdc: 7_000_000n,
} as const;

export class SetupStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupStopped';
  }
}

export type SetupContext = {
  readonly rpc: DemoRpc;
  readonly cast: Cast;
  readonly network: DemoNetwork;
  readonly setupStatePath: string;
  readonly log: Log;
};

export async function accountExists(rpc: DemoRpc, address: Address): Promise<boolean> {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64' }).send();
  return value !== null;
}

export async function tokenBalance(rpc: DemoRpc, account: Address): Promise<bigint> {
  const token = await fetchMaybeToken(rpc, account);
  return token.exists ? token.data.amount : 0n;
}

export async function solBalance(rpc: DemoRpc, account: Address): Promise<bigint> {
  return (await rpc.getBalance(account).send()).value;
}

async function rent(rpc: DemoRpc, space: number): Promise<bigint> {
  return rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runSetup(ctx: SetupContext): Promise<SetupRecord> {
  const { rpc, cast, network, log } = ctx;
  await assertRpcNetwork(rpc, network);
  const record: SetupRecord = existsSync(ctx.setupStatePath)
    ? readSetupRecord(ctx.setupStatePath)
    : { schema: SETUP_SCHEMA, network, steps: [] };
  const save = () => {
    writeJson(ctx.setupStatePath, record);
  };
  const payer = await setupSigner(cast, 'treasury');

  async function send(step: string, instructions: Instruction[]) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    // Recorded before the wait: if the confirmation is never seen (repeated HTTP 429, a timeout),
    // the record still names what was sent, and the next run can look it up.
    const index =
      record.steps.push({
        step,
        label: 'setup, not a scene',
        signature,
        ...explorerFor(network, signature),
        note: 'sent; the confirmation had not been seen when this was written',
      }) - 1;
    save();
    const { slot } = await sendAndConfirm(rpc, signed);
    record.steps[index] = {
      step,
      label: 'setup, not a scene',
      signature,
      slot: slot.toString(),
      ...explorerFor(network, signature),
    };
    save();
    log(`  ${step}`);
    log(`    ${shownLink(network, signature)}`);
  }

  log(`Setup for both demos on ${network}. Every transaction here is signed with the`);
  log('unwrapped setup key and recorded as "setup, not a scene".');
  log(`Treasury: ${cast.treasury}`);

  // 1. SOL for fees and rent: one airdrop request, never retried.
  if ((await solBalance(rpc, cast.treasury)) < AMOUNTS.treasuryMinLamports) {
    log('1. Requesting one airdrop of 1 SOL for the treasury (no retries).');
    let signature;
    try {
      signature = await rpc
        .requestAirdrop(cast.treasury, lamports(AMOUNTS.airdropLamports), {
          commitment: 'confirmed',
        })
        .send();
    } catch {
      throw new SetupStopped(
        `The airdrop was refused; devnet airdrops are rate-limited. Ask a person to request devnet SOL at faucet.solana.com for ${cast.treasury}, then run pnpm demo:setup again.`,
      );
    }
    const slot = await waitForConfirmation(rpc, signature);
    record.steps.push({
      step: 'airdrop of 1 SOL to the treasury',
      label: 'setup, not a scene',
      signature,
      slot: slot.toString(),
      ...explorerFor(network, signature),
    });
    save();
    log(`    ${shownLink(network, signature)}`);
  } else {
    log('1. The treasury already holds enough SOL. No airdrop.');
  }

  // 2. The USDC mint is what we expect.
  const mint = await fetchMaybeMint(rpc, cast.mint);
  if (!mint.exists || mint.programAddress !== TOKEN_PROGRAM_ADDRESS || mint.data.decimals !== 6) {
    throw new SetupStopped(
      `${cast.mint} is not an SPL Token mint with 6 decimals on this cluster.`,
    );
  }
  log(`2. USDC mint ${cast.mint}: SPL Token, 6 decimals.`);

  // 3. Token accounts for the payouts demo.
  const payoutsAccounts: Instruction[] = [];
  for (const [owner, ata] of [
    [cast.treasury, cast.treasuryAta],
    [cast.vendorA, cast.vendorAAta],
    [cast.vendorB, cast.vendorBAta],
    [cast.outsider, cast.outsiderAta],
  ] as const) {
    if (!(await accountExists(rpc, ata))) {
      payoutsAccounts.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: cast.mint }),
      );
    }
  }
  if (!(await accountExists(rpc, cast.outsiderPlainAccount))) {
    payoutsAccounts.push(
      getCreateAccountWithSeedInstruction({
        payer,
        newAccount: cast.outsiderPlainAccount,
        baseAccount: payer,
        base: cast.treasury,
        seed: PLAIN_ACCOUNT_SEED,
        amount: await rent(rpc, getTokenSize()),
        space: getTokenSize(),
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeAccount3Instruction({
        account: cast.outsiderPlainAccount,
        mint: cast.mint,
        owner: cast.outsider,
      }),
    );
  }
  if (payoutsAccounts.length > 0) {
    log('3. Token accounts:');
    await send(
      'USDC token accounts for the treasury, both vendors and the outsider, and a second outsider USDC account that is not associated',
      payoutsAccounts,
    );
  } else {
    log('3. The payouts token accounts exist.');
  }

  // 4. The durable-nonce account (scene 10 builds against it; nothing is ever sent with it).
  if (!(await accountExists(rpc, cast.nonceAccount))) {
    log('4. Durable-nonce account:');
    await send('durable-nonce account with the treasury as authority', [
      getCreateAccountWithSeedInstruction({
        payer,
        newAccount: cast.nonceAccount,
        baseAccount: payer,
        base: cast.treasury,
        seed: NONCE_ACCOUNT_SEED,
        amount: await rent(rpc, getNonceSize()),
        space: getNonceSize(),
        programAddress: SYSTEM_PROGRAM_ADDRESS,
      }),
      getInitializeNonceAccountInstruction({
        nonceAccount: cast.nonceAccount,
        nonceAuthority: cast.treasury,
      }),
    ]);
  } else {
    log('4. The durable-nonce account exists.');
  }

  // 5. The lookup table for scene 2, then wait until its entries are active.
  const entries = [cast.treasuryAta, cast.vendorAAta, cast.vendorBAta, cast.outsiderAta, cast.mint];
  if (
    record.lookupTable === undefined ||
    !(await accountExists(rpc, record.lookupTable as Address))
  ) {
    const recentSlot = await rpc.getSlot({ commitment: 'finalized' }).send();
    const [table] = await findAddressLookupTablePda({ authority: cast.treasury, recentSlot });
    // Recorded before it is sent: if the confirmation is never seen, the next run finds the table
    // on chain at this address instead of creating a second one.
    record.lookupTable = table;
    record.lookupTableEntries = entries;
    save();
    log('5. Lookup table:');
    await send('lookup table with the demo addresses', [
      await getCreateLookupTableInstructionAsync({ authority: payer, payer, recentSlot }),
      getExtendLookupTableInstruction({
        address: table,
        authority: payer,
        payer,
        addresses: entries,
      }),
    ]);
  } else {
    log(`5. Lookup table ${record.lookupTable} exists.`);
  }
  await waitUntilUsable(rpc, record.lookupTable as Address, log);

  // 6. x402: SOL for the local facilitator's fee payer, from the treasury.
  if ((await solBalance(rpc, cast.facilitatorFeePayer)) < AMOUNTS.facilitatorMinLamports) {
    log("6. SOL for the local facilitator's fee payer:");
    await send('0.05 SOL from the treasury to the local facilitator fee payer', [
      getTransferSolInstruction({
        source: payer,
        destination: cast.facilitatorFeePayer,
        amount: lamports(AMOUNTS.facilitatorFundingLamports),
      }),
    ]);
  } else {
    log("6. The local facilitator's fee payer holds enough SOL.");
  }

  // 7. x402: the agent's and the shop's USDC accounts, before the shop advertises its route.
  const x402Accounts: Instruction[] = [];
  for (const [owner, ata] of [
    [cast.agent, cast.agentAta],
    [cast.shop, cast.shopAta],
  ] as const) {
    if (!(await accountExists(rpc, ata))) {
      x402Accounts.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: cast.mint }),
      );
    }
  }
  if (x402Accounts.length > 0) {
    log('7. x402 token accounts:');
    await send(
      'USDC token accounts for the agent and the shop, paid by the treasury',
      x402Accounts,
    );
  } else {
    log('7. The x402 token accounts exist.');
  }

  // 8. The treasury needs USDC from a person (faucet.circle.com); setup never asks a faucet.
  const agentHolds = await tokenBalance(rpc, cast.agentAta);
  const topUp = agentHolds < AMOUNTS.agentUsdc ? AMOUNTS.agentUsdc - agentHolds : 0n;
  const treasuryHolds = await tokenBalance(rpc, cast.treasuryAta);
  if (treasuryHolds < AMOUNTS.scenesUsdc + topUp) {
    throw new SetupStopped(
      `The treasury holds ${usdc(treasuryHolds)} USDC; the demo needs ${usdc(AMOUNTS.scenesUsdc + topUp)}. Ask a person to request devnet USDC at faucet.circle.com (Solana Devnet) for ${cast.treasury}, then run pnpm demo:setup again.`,
    );
  }
  log(`8. The treasury holds ${usdc(treasuryHolds)} USDC.`);

  // 9. x402: 0.10 USDC to the agent, with the unwrapped setup key.
  if (topUp > 0n) {
    log('9. USDC for the agent:');
    await send(`${usdc(topUp)} USDC from the treasury to the agent`, [
      getTransferCheckedInstruction({
        source: cast.treasuryAta,
        mint: cast.mint,
        destination: cast.agentAta,
        authority: payer,
        amount: topUp,
        decimals: 6,
      }),
    ]);
  } else {
    log('9. The agent holds 0.10 USDC.');
  }

  save();
  log('Setup is complete.');
  return record;
}

/** Waits until the cluster's confirmed slot is past the table's last extension. */
async function waitUntilUsable(rpc: DemoRpc, table: Address, log: Log): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const account = await fetchMaybeAddressLookupTable(rpc, table, { commitment: 'confirmed' });
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    if (account.exists && slot > account.data.lastExtendedSlot) {
      log(`   The lookup table is usable (${String(account.data.addresses.length)} entries).`);
      return;
    }
    await sleep(1000);
  }
  throw new SetupStopped(`The lookup table ${table} did not become usable within 60 s.`);
}
