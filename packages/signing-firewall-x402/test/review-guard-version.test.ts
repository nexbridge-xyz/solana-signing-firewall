// Security review: the bound signer and the transaction version of a payment.
//
// The x402 `exact` scheme for Solana (pinned commit 4f64aba41) says of the payment a client
// sends: "Its message version MUST be one the requirements advertise in
// `extra.transactionVersions`, or version `0` when that field is absent (see §1.5)." and, of
// legacy messages, "They are never advertised in `extra.transactionVersions` and clients MUST
// NOT build them."
//
// The guard checked that the quote and the policy share a version, and that the message's
// version is in the policy. It never compared the message's version with the quote. A replaced
// or faulty SDK could so have the agent's key sign a version the quote does not offer. No value
// moves differently; a facilitator that follows its own accepted set refuses such a payment,
// and the budget reservation is spent for nothing.
//
// The verifier is right not to read the field (section 1.5: "The sponsor enforces its own
// accepted set; it does not read `PaymentRequirements.extra.transactionVersions`."); the last
// test pins that.
import { describe, expect, it } from 'vitest';
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import {
  type SnapshotAccount,
  createMemoryLedger,
  parsePolicy,
  parseVerifierConfig,
  reviewX402Payment,
  verifyX402Payment,
} from '@nexbridge/solana-signing-firewall';
import {
  FIXED_BLOCKHASH_FOR_TESTS,
  SDK_V1_CONFIG,
  agentPolicy,
  createX402World,
  facilitatorConfig,
  handBuilt,
  quote,
  sdkLayout,
  x402Accounts,
} from '@nexbridge/solana-signing-firewall-fixtures/x402';

const w = await createX402World();
const snapshot = {
  slot: 1000n,
  accounts: new Map<Address, SnapshotAccount | null>(x402Accounts(w)),
};
const now = new Date('2026-11-20T00:00:00.000Z');

const messageOf = (transaction: string) =>
  new Uint8Array(
    getTransactionDecoder().decode(getBase64Encoder().encode(transaction)).messageBytes,
  );

async function guard(messageBytes: Uint8Array, requirements: unknown, versions = ['v0', 'v1']) {
  const policy = parsePolicy({ ...agentPolicy(w), network: 'localnet', messageVersions: versions });
  if (policy.x402 === undefined) throw new Error('the fixture policy has an x402 block');
  const decision = await reviewX402Payment({
    messageBytes,
    requirements,
    policy: { ...policy, x402: policy.x402 },
    snapshot,
    ledger: createMemoryLedger(),
    now,
  });
  return [decision.outcome, ...decision.reasons.map((r) => r.code)];
}

const v0 = messageOf(await handBuilt(w, { version: 0, instructions: sdkLayout(w, 0, 'v') }));
const v1 = messageOf(
  await handBuilt(w, { version: 1, instructions: sdkLayout(w, 1, 'v'), config: SDK_V1_CONFIG }),
);
const withoutVersions = () => {
  const requirements = quote(w) as { extra: Record<string, unknown> };
  delete requirements.extra.transactionVersions;
  return requirements;
};

describe('the bound signer signs only a version the quote advertises', () => {
  it('allows the advertised versions (control)', async () => {
    expect(await guard(v1, quote(w))).toEqual(['allow']);
    expect(await guard(v0, quote(w))).toEqual(['allow']);
    expect(await guard(v0, quote(w, {}, { transactionVersions: [0] }))).toEqual(['allow']);
    expect(await guard(v0, withoutVersions())).toEqual(['allow']);
  });

  it('refuses version 1 when the quote advertises version 0 only, or nothing', async () => {
    expect(await guard(v1, quote(w, {}, { transactionVersions: [0] }))).toEqual([
      'deny',
      'VERSION_NOT_ALLOWED',
    ]);
    expect(await guard(v1, withoutVersions())).toEqual(['deny', 'VERSION_NOT_ALLOWED']);
  });

  it('refuses version 0 when the quote advertises version 1 only', async () => {
    expect(await guard(v0, quote(w, {}, { transactionVersions: [1] }))).toEqual([
      'deny',
      'VERSION_NOT_ALLOWED',
    ]);
  });

  it('refuses a legacy payment even when the policy lists legacy', async () => {
    const legacy = new Uint8Array(
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 'legacy' }),
          (m) => setTransactionMessageFeePayer(w.feePayer.address, m),
          (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash: FIXED_BLOCKHASH_FOR_TESTS, lastValidBlockHeight: 0n },
              m,
            ),
          (m) => appendTransactionMessageInstructions(sdkLayout(w, 0, 'legacy'), m),
        ),
      ).messageBytes,
    );
    expect(await guard(legacy, quote(w), ['legacy', 'v0', 'v1'])).toEqual([
      'deny',
      'VERSION_NOT_ALLOWED',
    ]);
  });

  it('leaves the verifier as it is: it applies its own accepted set, not the quote', async () => {
    const config = parseVerifierConfig(facilitatorConfig(w));
    const transaction = await handBuilt(w, {
      version: 1,
      instructions: sdkLayout(w, 1, 'v'),
      config: SDK_V1_CONFIG,
    });
    const decision = await verifyX402Payment({
      transaction,
      requirements: quote(w, {}, { transactionVersions: [0] }),
      config,
      snapshot,
      now,
    });
    expect(decision.outcome).toBe('valid');
  });
});
