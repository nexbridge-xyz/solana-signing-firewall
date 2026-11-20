// Security review: the verifier against an independent implementation.
//
// Every x402 vector, and thousands of mutated payments (re-signed by the buyer, so the signature
// is never the reason), go to our verifyX402Payment() and to the static checks of the pinned
// @x402/svm facilitator, with its simulation stubbed to succeed. Everything stays in this
// process: no service is started and nothing is sent.
//
// The property under test is one-sided, and about OUR verifier only: a payment our verifier
// calls valid must also pass the other implementation's static checks. A payment we refuse and
// the other accepts is expected (docs/X402.md lists where we are stricter) and is only counted.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  type Address,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signBytes,
} from '@solana/kit';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme as SdkFacilitator } from '@x402/svm/exact/facilitator';

import {
  type SnapshotAccount,
  parseVerifierConfig,
  snapshotFromJson,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';
import {
  SDK_V1_CONFIG,
  createX402World,
  facilitatorConfig,
  handBuilt,
  memoInstruction,
  quote,
  sdkLayout,
  x402Accounts,
} from '@nexbridge/solana-signing-firewall-fixtures/x402';

const w = await createX402World();
const config = parseVerifierConfig(facilitatorConfig(w));
const snapshot = {
  slot: 1000n,
  accounts: new Map<Address, SnapshotAccount | null>(x402Accounts(w)),
};
const now = new Date('2026-11-20T00:00:00.000Z');

/** The other implementation, with only its static checks: simulation always succeeds here. */
const sdk = new SdkFacilitator(
  {
    getAddresses: () => [w.feePayer.address],
    simulateTransaction: () => Promise.resolve(),
    signTransaction: () => Promise.reject(new Error('this test never signs')),
    sendTransaction: () => Promise.reject(new Error('this test never sends')),
    confirmTransaction: () => Promise.reject(new Error('this test never sends')),
  },
  undefined,
  { transactionVersions: [0, 1] },
);

async function both(transaction: string, requirements: unknown) {
  const ours = await verifyX402Payment({ transaction, requirements, config, snapshot, now });
  const payload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction },
  } as unknown as PaymentPayload;
  const theirs = await sdk.verify(payload, requirements as PaymentRequirements).catch(() => ({
    isValid: false,
    invalidReason: 'threw',
  }));
  return {
    oursValid: ours.outcome === 'valid',
    ourReasons: ours.reasons.map((r) => r.code),
    theirsValid: theirs.isValid,
    theirReason: theirs.invalidReason,
  };
}

const stats = { compared: 0, bothValid: 0, bothInvalid: 0, onlyWeRefuse: 0, onlyWeAccept: 0 };
const onlyWeAccept: string[] = [];

async function compare(label: string, transaction: string, requirements: unknown) {
  const result = await both(transaction, requirements);
  stats.compared += 1;
  if (result.oursValid && result.theirsValid) stats.bothValid += 1;
  else if (!result.oursValid && !result.theirsValid) stats.bothInvalid += 1;
  else if (!result.oursValid) stats.onlyWeRefuse += 1;
  else {
    stats.onlyWeAccept += 1;
    onlyWeAccept.push(`${label}: the other implementation says ${String(result.theirReason)}`);
  }
  return result;
}

// ------------------------------------------------------------------ mutated payments

/** Re-signs a (possibly edited) message with the buyer's key; other signature slots stay empty. */
async function wireFor(message: Uint8Array): Promise<string | undefined> {
  let signers: readonly Address[];
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  } catch {
    return undefined;
  }
  if (signers.length === 0 || signers.length > 12) return undefined;
  const signatures: number[] = [];
  for (const signer of signers) {
    signatures.push(
      ...(signer === w.agent.address
        ? new Uint8Array(await signBytes(w.agent.keyPair.privateKey, message))
        : new Uint8Array(64)),
    );
  }
  const wire =
    message[0] === 0x81
      ? new Uint8Array([...message, ...signatures])
      : new Uint8Array([signers.length, ...signatures, ...message]);
  return getBase64Decoder().decode(wire);
}

function structuralPositions(bytes: Uint8Array): number[] {
  const masked = new Uint8Array(bytes.length);
  const compiled = getCompiledTransactionMessageDecoder().decode(bytes);
  for (const address of [...compiled.staticAccounts, compiled.lifetimeToken as Address]) {
    const key = new Uint8Array(getAddressEncoder().encode(address));
    for (let i = 0; i + 32 <= bytes.length; i += 1) {
      if (key.every((byte, j) => bytes[i + j] === byte)) masked.fill(1, i, i + 32);
    }
  }
  const positions: number[] = [];
  masked.forEach((flag, i) => {
    if (flag === 0) positions.push(i);
  });
  return positions;
}

const messageOf = (transaction: string) =>
  new Uint8Array(
    getTransactionDecoder().decode(getBase64Encoder().encode(transaction)).messageBytes,
  );

const editArb = fc.array(
  fc.tuple(
    fc.nat(),
    fc.oneof(
      fc.integer({ min: 0, max: 255 }),
      fc.constantFrom(0, 1, 2, 3, 4, 12, 13, 0x7f, 0x80, 0xff),
    ),
    fc.constantFrom('set', 'set', 'add', 'sub'),
  ),
  { minLength: 1, maxLength: 3 },
);

const RUNS = Number(process.env.REVIEW_FUZZ_RUNS ?? 400);

describe('verifyX402Payment() against the @x402/svm facilitator (static checks)', () => {
  // The other implementation logs every transaction it cannot decode; thousands of them here.
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('agrees on the payments the pinned client layout builds (control)', async () => {
    const requirements = quote(w);
    for (const version of [0, 1] as const) {
      const transaction = await handBuilt(w, {
        version,
        instructions: sdkLayout(w, version, `control-${String(version)}`),
        ...(version === 1 ? { config: SDK_V1_CONFIG } : {}),
      });
      const result = await both(transaction, requirements);
      expect([result.oursValid, result.theirsValid, result.ourReasons]).toEqual([true, true, []]);
    }
  });

  it('never calls valid a committed vector the other implementation refuses', async () => {
    const dir = fileURLToPath(new URL('../../fixtures/vectors/x402/', import.meta.url));
    const before = onlyWeAccept.length;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const vector = JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as {
        id: string;
        transaction?: string;
        requirements: unknown;
        snapshot: Parameters<typeof snapshotFromJson>[0];
      };
      if (vector.transaction === undefined) continue;
      const ours = await verifyX402Payment({
        transaction: vector.transaction,
        requirements: vector.requirements,
        config,
        snapshot: snapshotFromJson(vector.snapshot),
        now,
      });
      const payload = {
        x402Version: 2,
        accepted: vector.requirements,
        payload: { transaction: vector.transaction },
      } as unknown as PaymentPayload;
      const theirs = await sdk
        .verify(payload, vector.requirements as PaymentRequirements)
        .catch(() => ({ isValid: false, invalidReason: 'threw' }));
      stats.compared += 1;
      if (ours.outcome === 'valid' && !theirs.isValid) {
        onlyWeAccept.push(
          `${vector.id}: the other implementation says ${String(theirs.invalidReason)}`,
        );
      }
    }
    expect(onlyWeAccept.slice(before)).toEqual([]);
  });

  it('never calls valid a mutated payment the other implementation refuses', async () => {
    const requirements = quote(w);
    const withMemo = quote(w, {}, { memo: 'order 7781' });
    const bases: [string, Uint8Array, unknown][] = [];
    for (const version of [0, 1] as const) {
      bases.push([
        `v${String(version)}`,
        messageOf(
          await handBuilt(w, {
            version,
            instructions: sdkLayout(w, version, `base-${String(version)}`),
            ...(version === 1 ? { config: SDK_V1_CONFIG } : {}),
          }),
        ),
        requirements,
      ]);
      const [first, ...rest] = sdkLayout(w, version, 'memo');
      const instructions = [first, ...rest.slice(0, -1), memoInstruction('order 7781')].filter(
        (ix) => ix !== undefined,
      );
      bases.push([
        `v${String(version)}-seller-memo`,
        messageOf(
          await handBuilt(w, {
            version,
            instructions,
            ...(version === 1 ? { config: SDK_V1_CONFIG } : {}),
          }),
        ),
        withMemo,
      ]);
    }
    const positions = bases.map(([, message]) => structuralPositions(message));

    await fc.assert(
      fc.asyncProperty(fc.nat(bases.length - 1), editArb, async (which, edits) => {
        const [label, message, quoted] = bases[which] as [string, Uint8Array, unknown];
        const candidates = positions[which] as number[];
        const mutated = new Uint8Array(message);
        for (const [pick, value, how] of edits) {
          const position = candidates[pick % candidates.length] as number;
          const current = mutated[position] as number;
          mutated[position] =
            how === 'set' ? value : how === 'add' ? (current + 1) & 0xff : (current - 1) & 0xff;
        }
        const transaction = await wireFor(mutated);
        if (transaction === undefined) return;
        const result = await compare(
          `${label} ${Buffer.from(mutated).toString('hex')}`,
          transaction,
          quoted,
        );
        expect(result.oursValid && !result.theirsValid).toBe(false);
      }),
      { numRuns: RUNS * 10 },
    );
    console.log('verifier differential:', JSON.stringify(stats));
    expect(onlyWeAccept).toEqual([]);
    // The mutations did reach payments both sides accept, and payments both refuse.
    expect(stats.bothValid).toBeGreaterThan(0);
    expect(stats.bothInvalid).toBeGreaterThan(0);
  }, 600_000);
});
