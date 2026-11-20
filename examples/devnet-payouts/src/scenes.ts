// Scenes 1 to 11 (the scene table of README.md). The treasury's Keychain memory signer is
// wrapped with withPolicy(); every scene goes through Kit's
// signTransactionMessageWithSigners, so the wrapper is the only way to a
// signature. Blocked scenes are never sent.
import {
  type Address,
  type Blockhash,
  type Instruction,
  type Nonce,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { fetchNonce } from '@solana-program/system';
import {
  getApproveInstruction,
  getBatchInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';

import {
  type ApprovalLookup,
  type ApprovalRecord,
  type Policy,
  type ReviewDecision,
  PolicyViolationError,
  createApproval,
  createRpcSnapshotLoader,
  decisionToJson,
  withPolicy,
} from '@nexbridge/solana-signing-firewall';
import {
  type Cast,
  type DemoNetwork,
  type DemoRpc,
  type Log,
  NAMES,
  type ReasonRecord,
  type SceneRecord,
  type StepRecord,
  explorerFor,
  keychainSigner,
  printScene,
  sendAndConfirm,
} from '@nexbridge/example-demo-common';

const CU_LIMIT = 30_000;
const CU_PRICE_MICRO_LAMPORTS = 1_000n;
const V1_CONFIG = {
  computeUnitLimit: 30_000,
  loadedAccountsDataSizeLimit: 1_048_576,
  priorityFeeLamports: 10_000n,
};

export type PayoutsContext = {
  readonly rpc: DemoRpc;
  readonly network: DemoNetwork;
  readonly cast: Cast;
  readonly policy: Policy;
  readonly lookupTable: Address;
  readonly lookupTableEntries: readonly Address[];
  readonly log: Log;
  readonly now?: () => Date;
  /** Called after each scene, so the run record can be written as the run goes. */
  readonly onScene?: (scene: SceneRecord) => void;
};

export const toReasonRecord = (reason: {
  code: string;
  path?: string;
  account?: string;
  program?: string;
}): ReasonRecord => ({
  code: reason.code,
  ...(reason.path === undefined ? {} : { path: reason.path }),
  ...(reason.account === undefined ? {} : { account: reason.account }),
  ...(reason.program === undefined ? {} : { program: reason.program }),
});

type Lifetime = { blockhash: Blockhash; lastValidBlockHeight: bigint };
type Signable = Parameters<typeof signTransactionMessageWithSigners>[0];

export async function runPayoutScenes(ctx: PayoutsContext): Promise<SceneRecord[]> {
  const { rpc, cast, log } = ctx;
  const inner = await keychainSigner(cast, 'treasury');
  const approver = await keychainSigner(cast, 'approver');
  const loader = createRpcSnapshotLoader(rpc);

  /** A fresh wrapper per scene, so each scene counts its own inner signer calls. */
  function wrap(approvals?: ApprovalLookup) {
    const counter = { calls: 0 };
    const decisions: ReviewDecision[] = [];
    const counted = {
      address: inner.address,
      isAvailable: () => inner.isAvailable(),
      signTransactions: (...args: Parameters<typeof inner.signTransactions>) => {
        counter.calls += 1;
        return inner.signTransactions(...args);
      },
    };
    const signer = withPolicy(counted, {
      policy: ctx.policy,
      loader,
      ...(approvals === undefined ? {} : { approvals }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      onDecision: (decision) => decisions.push(decision),
    });
    return { signer, counter, decisions };
  }
  type Wrapped = ReturnType<typeof wrap>;

  const latest = async (): Promise<Lifetime> =>
    (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value;
  const pay = (signer: TransactionSigner, destination: Address, amount: bigint) =>
    getTransferCheckedInstruction({
      source: cast.treasuryAta,
      mint: cast.mint,
      destination,
      authority: signer,
      amount,
      decimals: 6,
    });
  const computeLimit = () => getSetComputeUnitLimitInstruction({ units: CU_LIMIT });
  const computePrice = () =>
    getSetComputeUnitPriceInstruction({ microLamports: CU_PRICE_MICRO_LAMPORTS });

  const legacy = (signer: TransactionSigner, lifetime: Lifetime, instructions: Instruction[]) =>
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
  const v0 = (
    signer: TransactionSigner,
    lifetime: Lifetime,
    instructions: Instruction[],
    tables: Record<Address, Address[]> = {},
  ) =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
    );
  const v1 = (
    signer: TransactionSigner,
    lifetime: Lifetime,
    instructions: Instruction[],
    config: typeof V1_CONFIG,
  ) =>
    pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => setTransactionMessageConfig(config, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );

  /** Signs through the wrapper; sends only what the wrapper signed. */
  async function attempt(
    w: Wrapped,
    message: Signable,
    label: string,
  ): Promise<{ step: StepRecord; decision: ReviewDecision | undefined }> {
    const before = w.counter.calls;
    let signed;
    try {
      signed = await signTransactionMessageWithSigners(message);
    } catch (error) {
      if (!(error instanceof PolicyViolationError)) throw error;
      const decision = error.decision ?? w.decisions.at(-1);
      return {
        decision,
        step: {
          label,
          outcome: decision?.outcome ?? 'deny',
          reasons: error.reasons.map(toReasonRecord),
          ...(decision === undefined
            ? {}
            : {
                messageDigest: decision.messageDigest,
                policyId: decision.policyId,
                decision: decisionToJson(decision),
              }),
          signerCalls: w.counter.calls - before,
          sent: false,
        },
      };
    }
    const decision = w.decisions.at(-1);
    if (decision === undefined) throw new Error('the wrapper signed without a decision');
    const { signature, slot } = await sendAndConfirm(rpc, signed);
    return {
      decision,
      step: {
        label,
        outcome: decision.outcome === 'allow' ? 'allow' : 'allow with approval',
        reasons: [],
        messageDigest: decision.messageDigest,
        policyId: decision.policyId,
        decision: decisionToJson(decision),
        signerCalls: w.counter.calls - before,
        sent: true,
        signature,
        slot: slot.toString(),
        ...explorerFor(ctx.network, signature),
      },
    };
  }

  const scenes: SceneRecord[] = [];
  const done = (scene: SceneRecord) => {
    scenes.push(scene);
    printScene(log, scene);
    ctx.onScene?.(scene);
  };
  const tables = { [ctx.lookupTable]: [...ctx.lookupTableEntries] };

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      legacy(w.signer, await latest(), [
        pay(w.signer, cast.vendorAAta, 1_000_000n),
        computeLimit(),
      ]),
      'review, sign and send',
    );
    done({
      scene: 1,
      title: `Legacy transfer: 1.00 USDC to ${NAMES.vendorA}`,
      expected: 'allow, signed, sent',
      vectors: ['core-001'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const { step, decision } = await attempt(
      w,
      v0(
        w.signer,
        await latest(),
        [pay(w.signer, cast.vendorBAta, 1_500_000n), computeLimit(), computePrice()],
        tables,
      ),
      'review, sign and send',
    );
    const entries = decision?.lookupTableEntries ?? [];
    done({
      scene: 2,
      title: `v0 transfer through the lookup table: 1.50 USDC to ${NAMES.vendorB}`,
      expected: 'allow, sent; the lookup-table entries appear in the decision',
      vectors: ['core-002'],
      steps: [
        {
          ...step,
          note: `${String(entries.length)} accounts loaded from lookup table ${ctx.lookupTable}`,
        },
      ],
    });
  }

  {
    const w = wrap();
    const { step, decision } = await attempt(
      w,
      v1(w.signer, await latest(), [pay(w.signer, cast.vendorAAta, 500_000n)], V1_CONFIG),
      'review, sign and send',
    );
    done({
      scene: 3,
      title: `v1 transfer: 0.50 USDC to ${NAMES.vendorA}, priority fee within the cap`,
      expected: 'allow, sent; fees read from transactionConfig',
      vectors: ['core-003'],
      steps: [
        {
          ...step,
          note: `priority fee ${decision?.fees?.priorityFeeLamports.toString() ?? '?'} lamports and compute-unit limit ${decision?.fees?.computeUnitLimit?.toString() ?? '?'}, read from transactionConfig`,
        },
      ],
    });
  }

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      v0(w.signer, await latest(), [
        getBatchInstruction([
          pay(w.signer, cast.vendorAAta, 400_000n),
          pay(w.signer, cast.vendorBAta, 600_000n),
        ]),
        computeLimit(),
      ]),
      'review, sign and send',
    );
    done({
      scene: 4,
      title: `P-Token batch: 0.40 USDC to ${NAMES.vendorA} and 0.60 USDC to ${NAMES.vendorB} in one instruction`,
      expected: 'allow, sent',
      vectors: ['core-004'],
      steps: [step],
    });
  }

  let scene5Approval: ApprovalRecord | undefined;
  {
    const approvals = new Map<string, ApprovalRecord>();
    const w = wrap((digest) => approvals.get(digest));
    const message = v0(w.signer, await latest(), [
      pay(w.signer, cast.vendorBAta, 3_000_000n),
      computeLimit(),
    ]);
    const first = await attempt(w, message, 'first attempt');
    const steps = [first.step];
    if (first.decision?.outcome === 'needs_approval') {
      const issuedAt = ctx.now?.() ?? new Date();
      scene5Approval = await createApproval({
        decision: first.decision,
        approver,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 60_000),
      });
      approvals.set(scene5Approval.messageDigest, scene5Approval);
      const second = await attempt(w, message, 'after the approver signs');
      steps.push({
        ...second.step,
        approval: scene5Approval,
        note: `approved by ${scene5Approval.approver}, valid for 60 seconds, for message ${scene5Approval.messageDigest.slice(0, 12)}...`,
      });
    }
    done({
      scene: 5,
      title: `3.00 USDC to ${NAMES.vendorB}`,
      expected: 'needs approval; the approver signs; the wrapper signs; sent',
      vectors: ['core-005', 'core-016'],
      steps,
    });
  }

  {
    const presented = scene5Approval;
    const w = wrap(() => presented);
    const { step } = await attempt(
      w,
      v0(w.signer, await latest(), [pay(w.signer, cast.vendorBAta, 4_500_000n), computeLimit()]),
      "review with scene 5's approval",
    );
    done({
      scene: 6,
      title: `A new message for 4.50 USDC to ${NAMES.vendorB}, presented with scene 5's approval`,
      expected: 'APPROVAL_MESSAGE_MISMATCH; signer calls 0',
      vectors: ['core-019'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      v0(w.signer, await latest(), [
        pay(w.signer, cast.outsiderPlainAccount, 1_000_000n),
        computeLimit(),
      ]),
      'review',
    );
    done({
      scene: 7,
      title: "1.00 USDC into the outsider's USDC account that is not an associated token account",
      expected: 'RECIPIENT_NOT_ALLOWED, DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT; signer calls 0',
      vectors: ['core-052'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      v0(w.signer, await latest(), [
        pay(w.signer, cast.vendorAAta, 2_000_000n),
        pay(w.signer, cast.vendorBAta, 2_000_000n),
        pay(w.signer, cast.vendorAAta, 2_000_000n),
        computeLimit(),
      ]),
      'review',
    );
    done({
      scene: 8,
      title: 'Three transfers of 2.00 USDC in one transaction (cap 5.00)',
      expected: 'PER_TRANSACTION_LIMIT_EXCEEDED; signer calls 0',
      vectors: ['core-060'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      v0(w.signer, await latest(), [
        getBatchInstruction([
          pay(w.signer, cast.vendorAAta, 500_000n),
          getApproveInstruction({
            source: cast.treasuryAta,
            delegate: cast.outsider,
            owner: w.signer,
            amount: 1_000_000_000n,
          }),
        ]),
        computeLimit(),
      ]),
      'review',
    );
    done({
      scene: 9,
      title: `A batch with 0.50 USDC to ${NAMES.vendorA} plus an Approve that makes the outsider a delegate for 1,000 USDC`,
      expected: 'TOKEN_INSTRUCTION_NOT_ALLOWED at ix[0].batch[1]; signer calls 0',
      vectors: ['core-030'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const nonce = await fetchNonce(rpc, cast.nonceAccount, { commitment: 'confirmed' });
    const message = pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayerSigner(w.signer, m),
      (m) =>
        setTransactionMessageLifetimeUsingDurableNonce(
          {
            nonce: nonce.data.blockhash as string as Nonce,
            nonceAccountAddress: cast.nonceAccount,
            nonceAuthorityAddress: cast.treasury,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [pay(w.signer, cast.vendorAAta, 1_000_000n), computeLimit()],
          m,
        ),
    );
    const { step } = await attempt(w, message, 'review');
    done({
      scene: 10,
      title: `1.00 USDC to ${NAMES.vendorA} using the durable nonce`,
      expected: 'DURABLE_NONCE_NOT_ALLOWED; signer calls 0',
      vectors: ['core-028'],
      steps: [step],
    });
  }

  {
    const w = wrap();
    const { step } = await attempt(
      w,
      v1(
        w.signer,
        await latest(),
        [
          pay(w.signer, cast.vendorAAta, 500_000n),
          getSetComputeUnitPriceInstruction({ microLamports: 1n }),
        ],
        { ...V1_CONFIG, priorityFeeLamports: 5_000_000n },
      ),
      'review',
    );
    done({
      scene: 11,
      title:
        'v1 transfer with a 0.005 SOL priority fee in transactionConfig, plus a no-op SetComputeUnitPrice of 1 micro-lamport',
      expected: 'FEE_CAP_EXCEEDED, COMPUTE_BUDGET_INSTRUCTION_IN_V1; signer calls 0',
      vectors: ['core-037'],
      steps: [step],
    });
  }

  return scenes;
}
