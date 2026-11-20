import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { address, getBase64Encoder, getTransactionDecoder } from '@solana/kit';

import {
  type ReasonCode,
  checkQuote,
  createMemoryLedger,
  parsePolicy,
  parseVerifierConfig,
  reviewX402Payment,
  snapshotFromJson,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';

import { X402_DIR } from '../paths.js';
import type { X402Vector } from './format.js';

export type X402Result = { id: string; expected: string; actual: string; pass: boolean };

const set = (codes: readonly ReasonCode[]) => [...new Set(codes)].sort();
const show = (outcome: string, codes: readonly ReasonCode[]) =>
  codes.length === 0 ? outcome : `${outcome} ${set(codes).join(',')}`;

export async function runX402Vector(vector: X402Vector, dir = X402_DIR): Promise<X402Result> {
  const snapshot = snapshotFromJson(vector.snapshot);
  const now = new Date(vector.now);
  const expected: string[] = [];
  const actual: string[] = [];
  let pass = true;

  const client = vector.expect.client;
  if (client !== undefined && vector.policy !== undefined) {
    const policy = parsePolicy(JSON.parse(await readFile(join(dir, vector.policy), 'utf8')));
    if (policy.x402 === undefined) throw new Error(`${vector.id}: policy has no x402 section`);
    const x402Policy = { ...policy, x402: policy.x402 };
    const ledger = createMemoryLedger(
      (vector.ledger ?? []).map((r) => ({
        ...r,
        mint: address(r.mint),
        payee: address(r.payee),
        amount: BigInt(r.amount),
      })),
    );
    let outcome: string;
    let codes: ReasonCode[];
    if (vector.transaction === undefined) {
      const decision = checkQuote(vector.requirements, 0, { policy: x402Policy, ledger, now });
      outcome = decision.outcome;
      codes = decision.reasons.map((r) => r.code);
    } else {
      const wire = getTransactionDecoder().decode(getBase64Encoder().encode(vector.transaction));
      const decision = await reviewX402Payment({
        messageBytes: new Uint8Array(wire.messageBytes),
        requirements: vector.requirements,
        policy: x402Policy,
        snapshot,
        ledger,
        now,
      });
      outcome = decision.outcome;
      codes = decision.reasons.map((r) => r.code);
    }
    expected.push(`client ${show(client.outcome, client.reasons)}`);
    actual.push(`client ${show(outcome, codes)}`);
    pass &&= outcome === client.outcome && isDeepStrictEqual(set(codes), set(client.reasons));
  }

  const facilitator = vector.expect.facilitator;
  if (facilitator !== undefined && vector.verifierConfig !== undefined) {
    const config = parseVerifierConfig(
      JSON.parse(await readFile(join(dir, vector.verifierConfig), 'utf8')),
    );
    const decision = await verifyX402Payment({
      transaction: vector.transaction ?? '',
      requirements: vector.requirements,
      config,
      snapshot,
      now,
    });
    const codes = decision.reasons.map((r) => r.code);
    expected.push(`facilitator ${show(facilitator.outcome, facilitator.reasons)}`);
    actual.push(`facilitator ${show(decision.outcome, codes)}`);
    pass &&=
      decision.outcome === facilitator.outcome &&
      isDeepStrictEqual(set(codes), set(facilitator.reasons));
  }
  return { id: vector.id, expected: expected.join(' | '), actual: actual.join(' | '), pass };
}

export async function loadX402Vectors(dir = X402_DIR): Promise<X402Vector[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as X402Vector),
  );
}
