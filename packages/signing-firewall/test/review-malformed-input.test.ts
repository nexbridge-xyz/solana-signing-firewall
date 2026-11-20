// Security review: malformed input of every kind. Each entry point either returns a refusal or
// throws its own documented error class; none of them crashes with a TypeError, and none of them
// answers "allow" or "valid" for input that is not what it expects. These hold at the reviewed
// commit.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  PolicyError,
  VerifierConfigError,
  checkQuote,
  createMemoryLedger,
  decodeCompiledMessage,
  decodeTransactionMessage,
  parsePolicy,
  parseRequirements,
  parseTokenBatch,
  parseVerifierConfig,
  review,
  verifyApproval,
  verifyX402Payment,
} from '../src/index.js';
import { policyFor, policyJson, snapshotFor, testWorld, transferTransaction } from './world.js';

const w = await testWorld();
const policy = policyFor(w);
const snapshot = snapshotFor(w);
const now = new Date('2026-11-20T00:00:00.000Z');
const messageBytes = new Uint8Array(transferTransaction(w, 3_000_000n).messageBytes);

/** Any JSON value, including the shapes a hostile peer would try. */
const json = fc.oneof(
  fc.jsonValue(),
  fc.constantFrom(null, undefined, 0, '', [], {}, [[]], { __proto__: null }, 'x', true),
);

const verifierConfig = parseVerifierConfig({
  schema: 'solana-signing-firewall.x402-verifier/v0',
  networks: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
  feePayers: [w.outsider.address],
  messageVersions: ['v0', 'v1'],
  assets: { [w.mint]: { decimals: 6 } },
  maxComputeUnitLimit: 200000,
  maxComputeUnitPriceMicroLamports: '5000000',
  maxPriorityFeeLamports: '100000',
  maxRequiredSignatures: 2,
});

/** A valid object with one field replaced by arbitrary JSON, or one unknown field added. */
function withOneFieldReplaced(base: Record<string, unknown>) {
  return fc
    .tuple(fc.constantFrom(...Object.keys(base), 'unknownField'), json)
    .map(([key, value]) => ({ ...base, [key]: value }));
}

describe('malformed input', () => {
  it('parsePolicy(): a PolicyError or a policy, never another error', () => {
    const attempt = (value: unknown) => {
      try {
        parsePolicy(value);
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyError);
      }
    };
    fc.assert(fc.property(json, attempt), { numRuns: 300 });
    fc.assert(fc.property(withOneFieldReplaced(policyJson(w)), attempt), { numRuns: 600 });
  });

  it('parseVerifierConfig(): a VerifierConfigError or a config, never another error', () => {
    const base = {
      schema: 'solana-signing-firewall.x402-verifier/v0',
      networks: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
      feePayers: [w.outsider.address],
      messageVersions: ['v0', 'v1'],
      assets: { [w.mint]: { decimals: 6 } },
      maxComputeUnitLimit: 200000,
      maxComputeUnitPriceMicroLamports: '5000000',
      maxPriorityFeeLamports: '100000',
      maxRequiredSignatures: 2,
    };
    const attempt = (value: unknown) => {
      try {
        const parsed = parseVerifierConfig(value);
        // Whatever is accepted names at least one asset and one fee payer.
        expect(parsed.assets.size).toBeGreaterThan(0);
        expect(parsed.feePayers.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(VerifierConfigError);
      }
    };
    fc.assert(fc.property(json, attempt), { numRuns: 300 });
    fc.assert(fc.property(withOneFieldReplaced(base), attempt), { numRuns: 600 });
    // The two cases the builder reports as fixed, and their neighbours.
    for (const assets of [
      {},
      [],
      null,
      'x',
      7,
      { [w.mint]: null },
      { [w.mint]: 'x' },
      { [w.mint]: [] },
    ]) {
      expect(() => parseVerifierConfig({ ...base, assets })).toThrow(VerifierConfigError);
    }
    for (const decimals of [-1, 256, 1.5, '6', null, undefined, Number.NaN]) {
      expect(() => parseVerifierConfig({ ...base, assets: { [w.mint]: { decimals } } })).toThrow(
        VerifierConfigError,
      );
    }
  });

  it('parseRequirements() and checkQuote(): a refusal for anything that is not a quote, never a throw', () => {
    const x402Policy = policyFor(w, {
      memo: { allowed: true, maxBytes: 256 },
      x402: {
        networks: ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
        maxTimeoutSeconds: 120,
        maxComputeUnitPriceMicroLamports: '5000000',
        budgets: { [w.mint]: { maxPerDay: '50000' } },
        maxPaymentsPerMinute: 10,
      },
    });
    const ledger = createMemoryLedger();
    fc.assert(
      fc.property(json, (value) => {
        const parsed = parseRequirements(value);
        expect(parsed.ok).toBe(false);
        const decision = checkQuote(value, 0, {
          policy: x402Policy as typeof x402Policy & { x402: NonNullable<typeof x402Policy.x402> },
          ledger,
          now,
        });
        expect(decision.outcome).toBe('deny');
      }),
      { numRuns: 500 },
    );
  });

  it('verifyApproval(): reasons for anything that is not an approval, never a throw', async () => {
    await fc.assert(
      fc.asyncProperty(json, async (record) => {
        const reasons = await verifyApproval(record, { messageBytes, policy, now });
        expect(reasons.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('verifyX402Payment(): invalid for arbitrary strings and quotes, never a throw', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.base64String(), fc.constantFrom('', '=', 'AA==', 'gA==', 'AQ==')),
        json,
        async (transaction, requirements) => {
          const decision = await verifyX402Payment({
            transaction,
            requirements,
            config: verifierConfig,
            snapshot,
            now,
          });
          expect(decision.outcome).toBe('invalid');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('the decoder and review(): a refusal for arbitrary bytes, never a throw and never allow', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 600 }),
          fc
            .tuple(fc.constantFrom(0x80, 0x81, 0x01, 0x02), fc.uint8Array({ maxLength: 600 }))
            .map(([first, rest]) => new Uint8Array([first, ...rest])),
        ),
        async (bytes) => {
          expect(() => decodeCompiledMessage(bytes)).not.toThrow();
          expect(() => decodeTransactionMessage(bytes, snapshot)).not.toThrow();
          const decision = await review({ messageBytes: bytes, policy, snapshot, now });
          expect(decision.outcome).toBe('deny');
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('parseTokenBatch(): never throws, and what it accepts accounts for every byte and every account', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.nat(40), (rest, accounts) => {
        const data = new Uint8Array([255, ...rest]);
        const parsed = parseTokenBatch(data, accounts);
        if (!parsed.ok) return;
        let bytes = 1;
        let used = 0;
        for (const entry of parsed.entries) {
          expect(entry.data.length).toBeGreaterThan(0);
          expect(entry.accountOffset).toBe(used);
          bytes += 2 + entry.data.length;
          used += entry.accountCount;
        }
        expect(bytes).toBe(data.length);
        expect(used).toBe(accounts);
      }),
      { numRuns: 3000 },
    );
  });
});
