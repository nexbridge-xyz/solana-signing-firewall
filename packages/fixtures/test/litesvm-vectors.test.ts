// Runs core vectors in LiteSVM to confirm each vector's runtimeVerdict, and,
// for every vector review() lets through, that the token balance changes equal
// the transfers in the decision. The raw message bytes go to the runtime as
// they are, signed by the fixture keys of their required signers.
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  lamports,
  signBytes,
} from '@solana/kit';
import { getTokenDecoder, getTokenSize } from '@solana-program/token';

import {
  TOKEN_PROGRAM_ADDRESS,
  parsePolicy,
  review,
  snapshotFromJson,
} from '@nexbridge/solana-signing-firewall';

import type { CoreVector } from '../src/format.js';
import { CORE_DIR } from '../src/paths.js';
import { loadCoreVectors } from '../src/run.js';
import { type World, createWorld } from '../src/world.js';

type NativeSvm = {
  sendLegacyTransaction(bytes: Uint8Array): unknown;
  sendVersionedTransaction(bytes: Uint8Array): unknown;
};

const world: World = await createWorld();
const vectors: CoreVector[] = await loadCoreVectors();

function requiredSigners(message: Uint8Array): Address[] {
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    return compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  } catch {
    return [world.treasury.address];
  }
}

async function wireTransaction(message: Uint8Array): Promise<Uint8Array> {
  const signatures: Uint8Array[] = [];
  for (const signer of requiredSigners(message)) {
    const known = world.signers.get(signer);
    signatures.push(
      known === undefined
        ? new Uint8Array(64)
        : new Uint8Array(await signBytes(known.keyPair.privateKey, message)),
    );
  }
  const flat = signatures.flatMap((s) => [...s]);
  // SIMD-0385: a v1 transaction carries its signatures after the message, with no count.
  return message[0] === 0x81
    ? new Uint8Array([...message, ...flat])
    : new Uint8Array([signatures.length, ...flat, ...message]);
}

function tokenBalance(svm: LiteSVM, account: Address): bigint {
  const found = svm.getAccount(account);
  if (
    !found.exists ||
    found.programAddress !== TOKEN_PROGRAM_ADDRESS ||
    found.data.length !== getTokenSize()
  ) {
    return 0n;
  }
  return getTokenDecoder().decode(found.data).amount;
}

async function execute(vector: CoreVector) {
  const svm = new LiteSVM().withBlockhashCheck(false);
  const snapshot = snapshotFromJson(vector.snapshot);
  svm.warpToSlot(snapshot.slot);
  for (const [address, account] of snapshot.accounts) {
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
  for (const signer of world.signers.keys()) svm.airdrop(signer, lamports(10_000_000_000n));

  const message = new Uint8Array(getBase64Encoder().encode(vector.message));
  const native = (svm as unknown as { inner: NativeSvm }).inner;
  const balances = (accounts: Address[]) => new Map(accounts.map((a) => [a, tokenBalance(svm, a)]));
  const watched = [...snapshot.accounts.keys()];
  const before = balances(watched);
  let accepted: boolean;
  try {
    const wire = await wireTransaction(message);
    const result =
      (message[0] ?? 0) < 0x80
        ? native.sendLegacyTransaction(wire)
        : native.sendVersionedTransaction(wire);
    accepted = !(result instanceof FailedTransactionMetadata);
  } catch {
    accepted = false;
  }
  return { accepted, before, after: balances(watched), message, snapshot };
}

const checked = vectors.filter((v) => v.runtimeCheckedBy === 'litesvm');

describe('core vectors in LiteSVM', () => {
  it('explains every vector it does not check', () => {
    const unchecked = vectors.filter((v) => v.runtimeCheckedBy !== 'litesvm');
    expect(unchecked.filter((v) => (v.notes ?? '').length === 0).map((v) => v.id)).toEqual([]);
  });

  it.each(checked.map((v) => [v.id, v] as const))(
    '%s matches its runtimeVerdict',
    async (_id, vector) => {
      const run = await execute(vector);
      expect(run.accepted ? 'runtime_accepts' : 'runtime_rejects').toBe(vector.runtimeVerdict);

      if (!run.accepted || vector.expect.outcome === 'deny') return;
      // Allowed (or approvable) messages: balance changes must equal the reviewed transfers.
      const policy = parsePolicy(
        JSON.parse(await readFile(`${CORE_DIR}/${vector.policy}`, 'utf8')),
      );
      const decision = await review({
        messageBytes: run.message,
        policy,
        snapshot: run.snapshot,
        now: new Date(vector.now),
      });
      const expected = new Map<Address, bigint>();
      for (const t of decision.transfers) {
        expected.set(t.source, (expected.get(t.source) ?? 0n) - t.amount);
        expected.set(t.destination, (expected.get(t.destination) ?? 0n) + t.amount);
      }
      for (const [account, start] of run.before) {
        expect([account, (run.after.get(account) ?? 0n) - start]).toEqual([
          account,
          expected.get(account) ?? 0n,
        ]);
      }
    },
  );
});
