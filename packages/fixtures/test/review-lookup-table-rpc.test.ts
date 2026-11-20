// Security review: a documented limit, shown with the runtime.
//
// review() resolves lookup tables from the snapshot, and the snapshot comes from the RPC. An
// RPC that lies about the contents of a table makes review() see one destination while the
// runtime, which reads the real table, pays another. The associated-token-account rule does
// not help here: it checks the address review() resolved, and that address came from the RPC.
// (For an address written in the message itself, the rule does hold: see the second test.)
//
// The application in this test is honest. It compresses its message with the table contents
// the same RPC gave it, as Kit's helpers do.
import { describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  getCompiledTransactionMessageDecoder,
  lamports,
  signBytes,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getTokenDecoder, getTransferCheckedInstruction } from '@solana-program/token';

import { type SnapshotAccount, parsePolicy, review } from '@nexbridge/solana-signing-firewall';

import { compileV0, encode } from '../src/messages.js';
import {
  baseAccounts,
  createWorld,
  lookupTableAccount,
  payoutsPolicy,
  tokenAccount,
} from '../src/world.js';

const world = await createWorld();
const policy = parsePolicy(payoutsPolicy(world));
const SLOT = 1000n;
const now = new Date('2026-11-20T00:00:00.000Z');

type NativeSvm = { sendVersionedTransaction(bytes: Uint8Array): unknown };

async function execute(message: Uint8Array, accounts: [Address, SnapshotAccount | null][]) {
  const svm = new LiteSVM().withBlockhashCheck(false);
  svm.warpToSlot(SLOT);
  for (const [address, account] of accounts) {
    if (account === null) continue;
    svm.setAccount({
      address,
      data: account.data,
      executable: account.executable,
      lamports: lamports(account.lamports),
      programAddress: account.owner,
      space: BigInt(account.data.length),
    });
  }
  svm.airdrop(world.treasury.address, lamports(1_000_000_000n));
  const signature = new Uint8Array(await signBytes(world.treasury.keyPair.privateKey, message));
  const result = (svm as unknown as { inner: NativeSvm }).inner.sendVersionedTransaction(
    new Uint8Array([1, ...signature, ...message]),
  );
  const balance = (account: Address) => {
    const found = svm.getAccount(account);
    return found.exists ? getTokenDecoder().decode(found.data).amount : 0n;
  };
  return { accepted: !(result instanceof FailedTransactionMetadata), balance };
}

describe('a lying RPC and lookup tables', () => {
  it('redirects a payment review() allowed, and the associated-token-account rule does not notice', async () => {
    // The table as it is on chain: entry 1 is the outsider's USDC account.
    const onChain = [world.mint, world.outsiderAta];
    // The table as the RPC reports it, to the application and to the snapshot loader alike.
    const reported = [world.mint, world.vendorBAta];

    const message = encode(
      compileV0(
        world.treasury.address,
        [
          getTransferCheckedInstruction({
            source: world.treasuryAta,
            mint: world.mint,
            destination: world.vendorBAta,
            authority: world.treasury,
            amount: 1_500_000n,
            decimals: 6,
          }),
          getSetComputeUnitLimitInstruction({ units: 30_000 }),
        ],
        { [world.lookupTable]: reported },
      ),
    );
    // The destination is not in the message: only "entry 1 of the table" is.
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    expect(compiled.staticAccounts).not.toContain(world.vendorBAta);
    expect(compiled.staticAccounts).not.toContain(world.outsiderAta);

    const decision = await review({
      messageBytes: message,
      policy,
      snapshot: {
        slot: SLOT,
        accounts: new Map([
          ...baseAccounts(world),
          [world.lookupTable, lookupTableAccount(reported)],
        ]),
      },
      now,
    });
    expect(decision.outcome).toBe('allow');
    expect(decision.transfers.map((t) => [t.destination, t.destinationOwner])).toEqual([
      [world.vendorBAta, world.vendorB],
    ]);

    const run = await execute(message, [
      ...baseAccounts(world),
      [world.lookupTable, lookupTableAccount(onChain)],
    ]);
    expect(run.accepted).toBe(true);
    expect(run.balance(world.vendorBAta)).toBe(0n);
    expect(run.balance(world.outsiderAta)).toBe(1_500_000n);
  });

  it('cannot redirect a payment whose destination is written in the message (the rule holds there)', async () => {
    // Here the RPC lies about who owns the outsider's account: it reports vendor B.
    const message = encode(
      compileV0(
        world.treasury.address,
        [
          getTransferCheckedInstruction({
            source: world.treasuryAta,
            mint: world.mint,
            destination: world.outsiderAta,
            authority: world.treasury,
            amount: 1_500_000n,
            decimals: 6,
          }),
          getSetComputeUnitLimitInstruction({ units: 30_000 }),
        ],
        {},
      ),
    );
    const lied = new Map(baseAccounts(world));
    lied.set(world.outsiderAta, tokenAccount(world.mint, world.vendorB, 0n));
    const decision = await review({
      messageBytes: message,
      policy,
      snapshot: { slot: SLOT, accounts: lied },
      now,
    });
    expect([decision.outcome, ...decision.reasons.map((r) => r.code)]).toEqual([
      'deny',
      'DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT',
    ]);
  });
});
