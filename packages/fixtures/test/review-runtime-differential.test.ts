// Security review, guarantee G2: what review() reports must be what the runtime does.
//
// Random legacy, v0 (with a lookup table), v1 and P-Token batch messages, and
// byte-level mutations of them, go through review(). Every message review() does
// not deny is then signed and executed in LiteSVM against the same account state,
// and the complete state change is compared with the decision:
//   - token balances move by exactly the reviewed transfers;
//   - the fee payer pays exactly 5,000 lamports per signature plus the reported
//     priority fee (or less, when review() assumed 1,400,000 units);
//   - nothing else changes: no other lamports, no owner, no other data byte.
// A message review() allows but the runtime refuses is counted, not failed:
// failing on chain is safe. Doing something unreported is not.
import { appendFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  type Instruction,
  AccountRole,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  decompileTransactionMessage,
  isSignerRole,
  isWritableRole,
  lamports,
  signBytes,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  getBatchInstruction,
  getTokenDecoder,
  getTokenSize,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import {
  type ReviewDecision,
  SPL_MEMO_PROGRAM_ADDRESS,
  type Snapshot,
  type SnapshotAccount,
  TOKEN_PROGRAM_ADDRESS,
  decodeTransactionMessage,
  parsePolicy,
  review,
} from '@nexbridge/solana-signing-firewall';

import { compileLegacy, compileV0, compileV1, encode } from '../src/messages.js';
import {
  type World,
  baseAccounts,
  createWorld,
  lookupTableAccount,
  payoutsPolicy,
} from '../src/world.js';

type NativeSvm = {
  sendLegacyTransaction(bytes: Uint8Array): unknown;
  sendVersionedTransaction(bytes: Uint8Array): unknown;
};

const world: World = await createWorld();
const NOW = new Date('2026-11-20T00:00:00.000Z');
const SLOT = 1000n;
const SOL = 10_000_000_000n;

/** A permissive policy, so that as many generated messages as possible reach the runtime. */
const policy = parsePolicy({
  ...payoutsPolicy(world),
  feePayers: [world.treasury.address, world.sponsor.address],
  mints: { [world.mint]: { decimals: 6, maxPerTransaction: '40000000' } },
  fees: {
    maxComputeUnitLimit: 1_400_000,
    maxPriorityFeeLamports: '2000000000',
    requireExplicitComputeUnitLimit: false,
  },
  memo: { allowed: true, maxBytes: 64 },
  approval: undefined,
});

const TABLE_ENTRIES: Address[] = [
  world.mint,
  world.vendorAAta,
  world.vendorBAta,
  world.outsiderAta,
  world.treasuryAta,
];

function accountsFor(): [Address, SnapshotAccount | null][] {
  return [...baseAccounts(world), [world.lookupTable, lookupTableAccount(TABLE_ENTRIES)]];
}

const snapshot: Snapshot = { slot: SLOT, accounts: new Map(accountsFor()) };

// ------------------------------------------------------------------ execution

type AccountView = { lamports: bigint; owner: string; data: Uint8Array } | undefined;

function view(svm: LiteSVM, address: Address): AccountView {
  const found = svm.getAccount(address);
  if (!found.exists) return undefined;
  return {
    lamports: BigInt(found.lamports),
    owner: found.programAddress,
    data: new Uint8Array(found.data),
  };
}

function tokenAmount(account: AccountView): bigint | undefined {
  if (
    account === undefined ||
    account.owner !== TOKEN_PROGRAM_ADDRESS ||
    account.data.length !== getTokenSize()
  ) {
    return undefined;
  }
  return getTokenDecoder().decode(account.data).amount;
}

async function wireTransaction(message: Uint8Array): Promise<Uint8Array | undefined> {
  let signers: readonly Address[];
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  } catch {
    return undefined;
  }
  const signatures: number[] = [];
  for (const signer of signers) {
    const known = world.signers.get(signer);
    if (known === undefined) return undefined;
    signatures.push(...new Uint8Array(await signBytes(known.keyPair.privateKey, message)));
  }
  return message[0] === 0x81
    ? new Uint8Array([...message, ...signatures])
    : new Uint8Array([signers.length, ...signatures, ...message]);
}

type Run = {
  accepted: boolean;
  error: string | undefined;
  before: Map<Address, AccountView>;
  after: Map<Address, AccountView>;
};

async function execute(message: Uint8Array, watch: readonly Address[]): Promise<Run | undefined> {
  const wire = await wireTransaction(message);
  if (wire === undefined) return undefined;
  const svm = new LiteSVM().withBlockhashCheck(false);
  svm.warpToSlot(SLOT);
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
  for (const signer of world.signers.keys()) svm.airdrop(signer, lamports(SOL));
  const watched = [...new Set<Address>([...watch, ...snapshot.accounts.keys()])];
  const before = new Map(watched.map((a) => [a, view(svm, a)]));
  const native = (svm as unknown as { inner: NativeSvm }).inner;
  // LiteSVM aborts the whole process on bytes it cannot deserialize. With REVIEW_FUZZ_TRACE set,
  // the last line of that file is the message that did it.
  if (process.env.REVIEW_FUZZ_TRACE !== undefined) {
    appendFileSync(process.env.REVIEW_FUZZ_TRACE, `${Buffer.from(message).toString('hex')}\n`);
  }
  const result =
    (message[0] ?? 0) < 0x80
      ? native.sendLegacyTransaction(wire)
      : native.sendVersionedTransaction(wire);
  const failed = result instanceof FailedTransactionMetadata;
  return {
    accepted: !failed,
    error: failed ? result.toString() : undefined,
    before,
    after: new Map(watched.map((a) => [a, view(svm, a)])),
  };
}

// ------------------------------------------------------------------ the property

const stats = {
  reviewed: 0,
  allowed: 0,
  executed: 0,
  oversized: 0,
  notCanonical: 0,
  notCanonicalSample: undefined as string | undefined,
  runtimeRejected: new Map<string, number>(),
  rejectedSamples: new Map<string, string>(),
};

/** Packet limits: 1,232 bytes for legacy and v0 transactions, 4,096 for v1 (SIMD-0385). */
function wireSize(message: Uint8Array, signatures: number): number {
  return message[0] === 0x81
    ? message.length + 64 * signatures
    : 1 + 64 * signatures + message.length;
}

/** Throws with a description when the runtime did something review() did not report. */
async function assertRuntimeMatches(message: Uint8Array, decision: ReviewDecision): Promise<void> {
  stats.reviewed += 1;
  if (decision.outcome === 'deny') return;
  stats.allowed += 1;

  const compiled = getCompiledTransactionMessageDecoder().decode(message);
  // Kit's decoder reads an absent trailing array as empty, so it accepts a v0 message without its
  // lookup-table count and a legacy message without its instruction count. The runtime cannot
  // deserialize those (LiteSVM aborts on them). They are counted here and reported in the review.
  const canonical = new Uint8Array(getCompiledTransactionMessageEncoder().encode(compiled));
  if (canonical.length !== message.length || !canonical.every((byte, i) => byte === message[i])) {
    stats.notCanonical += 1;
    stats.notCanonicalSample ??= Buffer.from(message).toString('hex');
    return;
  }
  // LiteSVM aborts the process on a transaction over the packet limit; the runtime refuses it.
  const limit = message[0] === 0x81 ? 4096 : 1232;
  if (wireSize(message, compiled.header.numSignerAccounts) > limit) {
    stats.oversized += 1;
    return;
  }
  const run = await execute(message, compiled.staticAccounts);
  if (run === undefined) throw new Error('review() allowed a message a known signer cannot sign');
  if (!run.accepted) {
    const key = `${decision.version ?? '?'} ${/err: ([A-Za-z]+(\([^)]*\))?)/.exec(run.error ?? '')?.[1] ?? 'unknown'}`;
    stats.runtimeRejected.set(key, (stats.runtimeRejected.get(key) ?? 0) + 1);
    if (!stats.rejectedSamples.has(key))
      stats.rejectedSamples.set(key, Buffer.from(message).toString('hex'));
    // A rejected transaction must still change nothing but the fee payer's lamports.
  } else {
    stats.executed += 1;
  }

  const tokenDelta = new Map<Address, bigint>();
  if (run.accepted) {
    for (const t of decision.transfers) {
      tokenDelta.set(t.source, (tokenDelta.get(t.source) ?? 0n) - t.amount);
      tokenDelta.set(t.destination, (tokenDelta.get(t.destination) ?? 0n) + t.amount);
    }
  }
  const feePayer = decision.feePayer;
  const fees = decision.fees;
  if (feePayer === undefined || fees === undefined) throw new Error('allowed without a fee payer');
  const baseFee = 5_000n * BigInt(decision.requiredSigners.length);
  const reportedFee = baseFee + fees.priorityFeeLamports;

  for (const [address, start] of run.before) {
    const end = run.after.get(address);
    const where = `${address} (${decision.version ?? '?'})`;
    if ((start === undefined) !== (end === undefined)) {
      throw new Error(`${where}: account ${start === undefined ? 'created' : 'closed'}`);
    }
    if (start === undefined || end === undefined) continue;
    if (start.owner !== end.owner) throw new Error(`${where}: owner changed`);

    const lamportDelta = end.lamports - start.lamports;
    if (address === feePayer) {
      const paid = -lamportDelta;
      const exact = fees.source === 'transactionConfig' || fees.computeUnitLimit !== undefined;
      // A transaction the runtime refuses before execution costs nothing; one that fails
      // during execution still pays its fee.
      if (!run.accepted && paid === 0n) continue;
      if (exact ? paid !== reportedFee : paid > reportedFee || paid < baseFee) {
        throw new Error(
          `${where}: fee payer paid ${paid} lamports, review() reported ${reportedFee}` +
            ` (base ${baseFee}, priority ${fees.priorityFeeLamports}, exact=${exact})`,
        );
      }
    } else if (lamportDelta !== 0n) {
      throw new Error(`${where}: lamports changed by ${lamportDelta}`);
    }

    const startAmount = tokenAmount(start);
    const endAmount = tokenAmount(end);
    if (startAmount !== undefined && endAmount !== undefined) {
      const moved = endAmount - startAmount;
      const expected = tokenDelta.get(address) ?? 0n;
      if (moved !== expected) {
        throw new Error(`${where}: token balance moved by ${moved}, review() reported ${expected}`);
      }
      // Apart from the amount (bytes 64..72 of a token account) no byte may change.
      const a = new Uint8Array(start.data);
      const b = new Uint8Array(end.data);
      a.fill(0, 64, 72);
      b.fill(0, 64, 72);
      if (!a.every((byte, i) => byte === b[i]))
        throw new Error(`${where}: token account rewritten`);
    } else if (
      start.data.length !== end.data.length ||
      !start.data.every((byte, i) => byte === end.data[i])
    ) {
      throw new Error(`${where}: data changed`);
    }
  }
}

// ------------------------------------------------------------------ generators

const destination = fc.constantFrom(world.vendorAAta, world.vendorBAta);
const anyTokenAccount = fc.constantFrom(
  world.vendorAAta,
  world.vendorBAta,
  world.outsiderAta,
  world.treasuryAta,
);

const transfer = (to: Address, amount: bigint, source: Address = world.treasuryAta) =>
  getTransferCheckedInstruction({
    source,
    mint: world.mint,
    destination: to,
    authority: world.treasury,
    amount,
    decimals: 6,
  });

const transferArb = fc
  .tuple(destination, fc.bigInt({ min: 1n, max: 3_000_000n }))
  .map(([to, amount]) => transfer(to, amount));

/** Now and then a transfer review() must refuse: the outsider, or a self-transfer. */
const oddTransferArb = fc
  .tuple(anyTokenAccount, fc.bigInt({ min: 0n, max: 60_000_000n }))
  .map(([to, amount]) => transfer(to, amount));

const batchArb = fc
  .array(
    fc.oneof({ weight: 6, arbitrary: transferArb }, { weight: 1, arbitrary: oddTransferArb }),
    {
      minLength: 1,
      maxLength: 3,
    },
  )
  .map((entries) => getBatchInstruction(entries) as Instruction);

const memoArb = fc
  .tuple(fc.string({ maxLength: 40 }), fc.boolean())
  .map(([text, withSigner]): Instruction => ({
    programAddress: SPL_MEMO_PROGRAM_ADDRESS,
    accounts: withSigner
      ? [{ address: world.treasury.address, role: AccountRole.READONLY_SIGNER }]
      : [],
    data: new TextEncoder().encode(text),
  }));

const limitArb = fc
  .integer({ min: 0, max: 1_500_000 })
  .map((units) => getSetComputeUnitLimitInstruction({ units }) as Instruction);
const priceArb = fc
  .bigInt({ min: 0n, max: 1_000_000n })
  .map((microLamports) => getSetComputeUnitPriceInstruction({ microLamports }) as Instruction);

const bodyArb = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: transferArb },
    { weight: 3, arbitrary: batchArb },
    { weight: 2, arbitrary: memoArb },
    { weight: 1, arbitrary: oddTransferArb },
  ),
  { minLength: 1, maxLength: 4 },
);

const feePayerArb = fc.constantFrom(world.treasury.address, world.sponsor.address);

/** Legacy and v0: ComputeBudget instructions at random positions, each present or not. */
const withBudget = fc
  .tuple(bodyArb, fc.option(limitArb), fc.option(priceArb), fc.nat(8), fc.nat(8))
  .map(([body, limit, price, i, j]) => {
    const all = [...body];
    if (limit !== null) all.splice(i % (all.length + 1), 0, limit);
    if (price !== null) all.splice(j % (all.length + 1), 0, price);
    return all;
  });

const legacyArb = fc
  .tuple(feePayerArb, withBudget)
  .map(([payer, ixs]) => encode(compileLegacy(payer, ixs)));

const v0Arb = fc
  .tuple(feePayerArb, withBudget, fc.subarray(TABLE_ENTRIES))
  .map(([payer, ixs, entries]) =>
    encode(
      compileV0(payer, ixs, entries.length === 0 ? {} : { [world.lookupTable]: TABLE_ENTRIES }),
    ),
  );

const v1ConfigArb = fc.record(
  {
    computeUnitLimit: fc.integer({ min: 0, max: 1_400_000 }),
    priorityFeeLamports: fc.bigInt({ min: 0n, max: 5_000_000n }),
    loadedAccountsDataSizeLimit: fc.integer({ min: 0, max: 64 * 1024 * 1024 }),
    heapSize: fc.integer({ min: 32, max: 256 }).map((k) => k * 1024),
  },
  { requiredKeys: [] },
);

const v1Arb = fc
  .tuple(feePayerArb, bodyArb, v1ConfigArb)
  .map(([payer, ixs, config]) => encode(compileV1(payer, ixs, config)));

const messageArb = fc.oneof(legacyArb, v0Arb, v1Arb);

/**
 * One to three byte edits, a truncation or an extension. Most edits land on the bytes that carry
 * structure (header, counts, indexes, lengths, discriminators, amounts, config), not inside the
 * 32-byte addresses and the blockhash, where an edit only ever produces an unknown account.
 */
const mutationArb = fc.tuple(
  fc.array(
    fc.tuple(
      fc.nat(),
      fc.oneof(
        fc.integer({ min: 0, max: 255 }),
        fc.constantFrom(0, 1, 2, 3, 4, 12, 13, 0x7f, 0x80, 0x81, 0xfe, 0xff),
      ),
      fc.constantFrom('set', 'set', 'add', 'sub'),
    ),
    { minLength: 1, maxLength: 3 },
  ),
  fc.constantFrom('structure', 'structure', 'structure', 'structure', 'edit', 'truncate', 'extend'),
);
type Mutation = [[number, number, string][], string];

function structuralPositions(bytes: Uint8Array): number[] {
  const masked = new Uint8Array(bytes.length);
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(bytes);
    const keys: Uint8Array[] = [
      ...compiled.staticAccounts.map((a) => new Uint8Array(getAddressEncoder().encode(a))),
      new Uint8Array(getAddressEncoder().encode(compiled.lifetimeToken as Address)),
      ...('addressTableLookups' in compiled
        ? (compiled.addressTableLookups ?? []).map(
            (l) => new Uint8Array(getAddressEncoder().encode(l.lookupTableAddress)),
          )
        : []),
    ];
    for (const key of keys) {
      for (let i = 0; i + 32 <= bytes.length; i += 1) {
        if (key.every((byte, j) => bytes[i + j] === byte)) masked.fill(1, i, i + 32);
      }
    }
  } catch {
    // Not decodable: every position counts.
  }
  const positions: number[] = [];
  masked.forEach((flag, i) => {
    if (flag === 0) positions.push(i);
  });
  return positions.length === 0 ? [...bytes.keys()] : positions;
}

function mutate(bytes: Uint8Array, [edits, kind]: Mutation): Uint8Array {
  if (kind === 'truncate')
    return bytes.slice(0, Math.max(1, bytes.length - 1 - ((edits[0]?.[0] ?? 0) % 8)));
  if (kind === 'extend') return new Uint8Array([...bytes, ...edits.map(([, value]) => value)]);
  const copy = new Uint8Array(bytes);
  const positions = kind === 'structure' ? structuralPositions(bytes) : [...bytes.keys()];
  for (const [pick, value, how] of edits) {
    const position = positions[pick % positions.length] as number;
    const current = copy[position] as number;
    copy[position] =
      how === 'set' ? value : how === 'add' ? (current + 1) & 0xff : (current - 1) & 0xff;
  }
  return copy;
}

const RUNS = Number(process.env.REVIEW_FUZZ_RUNS ?? 400);

describe("the decoder against Kit's own decompiler", () => {
  it('resolves every instruction to the same program, accounts, signer and writable flags, and data', () => {
    fc.assert(
      fc.property(messageArb, (message) => {
        const ours = decodeTransactionMessage(message, snapshot);
        expect(ours.ok).toBe(true);
        if (!ours.ok) return;
        const compiled = getCompiledTransactionMessageDecoder().decode(message);
        const kit = decompileTransactionMessage(compiled, {
          addressesByLookupTableAddress: { [world.lookupTable]: TABLE_ENTRIES },
        });
        expect(ours.value.feePayer).toBe(kit.feePayer.address);
        expect(ours.value.instructions.length).toBe(kit.instructions.length);
        ours.value.instructions.forEach((ix, i) => {
          const theirs = kit.instructions[i];
          expect(ix.programAddress).toBe(theirs?.programAddress);
          expect([...ix.data]).toEqual([...(theirs?.data ?? [])]);
          expect(ix.accounts.map((a) => [a.address, a.isSigner, a.isWritable])).toEqual(
            (theirs?.accounts ?? []).map((a) => [
              a.address,
              isSignerRole(a.role),
              isWritableRole(a.role),
            ]),
          );
        });
      }),
      { numRuns: RUNS * 3 },
    );
  });
});

describe('review() against the runtime (LiteSVM)', () => {
  it('well-formed random messages: what is allowed executes exactly as reported', async () => {
    await fc.assert(
      fc.asyncProperty(messageArb, async (message) => {
        const decision = await review({ messageBytes: message, policy, snapshot, now: NOW });
        await assertRuntimeMatches(message, decision);
      }),
      { numRuns: RUNS },
    );
    console.log(
      'well-formed:',
      JSON.stringify({
        ...stats,
        runtimeRejected: [...stats.runtimeRejected],
        rejectedSamples:
          process.env.REVIEW_FUZZ_SAMPLES === undefined ? undefined : [...stats.rejectedSamples],
      }),
    );
    expect(stats.executed).toBeGreaterThan(RUNS / 10);
  }, 600_000);

  it('byte-mutated messages: whatever review() still allows executes exactly as reported', async () => {
    const start = { ...stats };
    await fc.assert(
      fc.asyncProperty(messageArb, mutationArb, async (message, mutation) => {
        const mutated = mutate(message, mutation);
        const decision = await review({ messageBytes: mutated, policy, snapshot, now: NOW });
        await assertRuntimeMatches(mutated, decision);
      }),
      { numRuns: RUNS * 5 },
    );
    console.log(
      'mutated:',
      JSON.stringify({
        reviewed: stats.reviewed - start.reviewed,
        allowed: stats.allowed - start.allowed,
        executed: stats.executed - start.executed,
        oversized: stats.oversized - start.oversized,
        notCanonical: stats.notCanonical - start.notCanonical,
        notCanonicalSample: stats.notCanonicalSample,
        runtimeRejected: [...stats.runtimeRejected],
      }),
    );
  }, 900_000);
});
