import type { Address } from '@solana/kit';
import {
  AccountState,
  findAssociatedTokenPda,
  getMintDecoder,
  getMintSize,
  getTokenDecoder,
  getTokenSize,
} from '@solana-program/token';

import { sha256Hex } from '../canonical.js';
import { decodeTransactionMessage } from '../decode/index.js';
import type { DecodedTransactionMessage, Transfer } from '../decode/types.js';
import { type Policy, policyDigest } from '../policy.js';
import { TOKEN_PROGRAM_ADDRESS } from '../programs.js';
import type { Reason } from '../reasons.js';
import type { Snapshot, SnapshotAccount } from '../snapshot.js';
import type { FeeSummary, Outcome, ReviewDecision, ReviewedTransfer } from './decision.js';

/** Compute units assumed for the fee when a legacy or v0 message sets no limit (the maximum). */
const ASSUMED_COMPUTE_UNIT_LIMIT = 1_400_000;

export type ReviewInput = {
  readonly messageBytes: Uint8Array;
  readonly policy: Policy;
  readonly snapshot: Snapshot;
  readonly now: Date;
};

type TokenAccountState = { mint: Address; owner: Address; state: AccountState };

/** Reads an SPL Token account from the snapshot; a string explains why it is not one. */
function tokenAccount(account: SnapshotAccount): TokenAccountState | string {
  if (account.owner !== TOKEN_PROGRAM_ADDRESS) return `owned by ${account.owner}`;
  if (account.data.length !== getTokenSize()) return `data is ${account.data.length} bytes`;
  let token;
  try {
    token = getTokenDecoder().decode(account.data);
  } catch {
    // Bytes the token program never writes (an unknown state byte, for example).
    return 'data is not a token account';
  }
  if (token.state === AccountState.Uninitialized) return 'not initialized';
  return { mint: token.mint, owner: token.owner, state: token.state };
}

function mintDecimals(account: SnapshotAccount): number | string {
  if (account.owner !== TOKEN_PROGRAM_ADDRESS) return `owned by ${account.owner}`;
  if (account.data.length !== getMintSize()) return `data is ${account.data.length} bytes`;
  let mint;
  try {
    mint = getMintDecoder().decode(account.data);
  } catch {
    return 'data is not a mint';
  }
  if (!mint.isInitialized) return 'not initialized';
  return mint.decimals;
}

function checkInstructions(
  message: DecodedTransactionMessage,
  policy: Policy,
  reasons: Reason[],
): void {
  let limits = 0;
  let prices = 0;
  for (const ix of message.instructions) {
    const at = { path: ix.path };
    switch (ix.program) {
      case 'spl-token':
        if (ix.token.type === 'batch') {
          if (policy.tokenBatch === 'deny') {
            reasons.push({ code: 'TOKEN_BATCH_NOT_ALLOWED', ...at });
            break;
          }
          for (const entry of ix.token.entries) {
            if (entry.instruction.type !== 'transfer-checked') {
              reasons.push({
                code: 'TOKEN_INSTRUCTION_NOT_ALLOWED',
                path: entry.path,
                detail:
                  entry.instruction.type === 'other'
                    ? (entry.instruction.name ?? 'unknown')
                    : 'batch',
              });
            }
          }
        } else if (ix.token.type === 'other') {
          reasons.push({
            code: 'TOKEN_INSTRUCTION_NOT_ALLOWED',
            ...at,
            detail: [ix.token.name ?? 'unknown', ix.token.detail].filter(Boolean).join(': '),
          });
        }
        break;
      case 'token-2022':
        reasons.push({ code: 'TOKEN_PROGRAM_NOT_ALLOWED', ...at, program: ix.programAddress });
        break;
      case 'compute-budget':
        if (message.version === 'v1') {
          reasons.push({ code: 'COMPUTE_BUDGET_INSTRUCTION_IN_V1', ...at });
        } else if (ix.computeBudget.type === 'set-compute-unit-limit' && ++limits === 1) {
          // first SetComputeUnitLimit: allowed
        } else if (ix.computeBudget.type === 'set-compute-unit-price' && ++prices === 1) {
          // first SetComputeUnitPrice: allowed
        } else {
          reasons.push({
            code: 'COMPUTE_BUDGET_INSTRUCTION_NOT_ALLOWED',
            ...at,
            detail:
              ix.computeBudget.type === 'other'
                ? (ix.computeBudget.name ?? 'unknown')
                : `${ix.computeBudget.type} more than once`,
          });
        }
        break;
      case 'memo': {
        const problem = memoProblem(ix.data, ix.accounts, policy);
        if (problem !== undefined)
          reasons.push({ code: 'MEMO_NOT_ALLOWED', ...at, detail: problem });
        break;
      }
      case 'system':
        // A nonce advance is reported once, as DURABLE_NONCE_NOT_ALLOWED.
        if (!ix.advancesNonce) reasons.push({ code: 'SYSTEM_INSTRUCTION_NOT_ALLOWED', ...at });
        break;
      case 'other':
        reasons.push({ code: 'PROGRAM_NOT_ALLOWED', ...at, program: ix.programAddress });
        break;
    }
  }
}

function memoProblem(
  data: Uint8Array,
  accounts: readonly { address: Address }[],
  policy: Policy,
): string | undefined {
  if (!policy.memo.allowed) return 'memos are not allowed';
  if (data.length > policy.memo.maxBytes)
    return `${data.length} bytes; at most ${policy.memo.maxBytes}`;
  if (accounts.some((account) => account.address !== policy.signer)) {
    return 'accounts other than the policy signer';
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return 'not valid UTF-8';
  }
  return undefined;
}

async function checkTransfer(
  transfer: Transfer,
  message: DecodedTransactionMessage,
  policy: Policy,
  snapshot: Snapshot,
  reasons: Reason[],
): Promise<ReviewedTransfer> {
  const at = { path: transfer.path };
  const missing = (account: Address) =>
    reasons.push({ code: 'ACCOUNT_STATE_MISSING', ...at, account, detail: 'not in the snapshot' });

  // Authority: the policy signer, acting directly.
  if (transfer.multisigSigners.length > 0) {
    reasons.push({ code: 'MULTISIG_AUTHORITY_NOT_SUPPORTED', ...at });
  } else {
    const authorityIsSigner = message.accountKeys.some(
      (key) => key.address === transfer.authority && key.isSigner,
    );
    if (transfer.authority !== policy.signer || !authorityIsSigner) {
      reasons.push({ code: 'AUTHORITY_NOT_POLICY_SIGNER', ...at, account: transfer.authority });
    }
  }

  // Mint.
  const rule = policy.mints.get(transfer.mint);
  if (rule === undefined) reasons.push({ code: 'MINT_NOT_ALLOWED', ...at, account: transfer.mint });
  const mintAccount = snapshot.accounts.get(transfer.mint);
  if (mintAccount === undefined) {
    missing(transfer.mint);
  } else {
    const decimals = mintAccount === null ? 'does not exist' : mintDecimals(mintAccount);
    if (typeof decimals === 'string') {
      reasons.push({
        code: 'MINT_ACCOUNT_INVALID',
        ...at,
        account: transfer.mint,
        detail: decimals,
      });
    } else if (
      transfer.decimals !== decimals ||
      (rule !== undefined && transfer.decimals !== rule.decimals)
    ) {
      reasons.push({
        code: 'DECIMALS_MISMATCH',
        ...at,
        detail: `instruction ${transfer.decimals}, mint ${decimals}, policy ${rule?.decimals ?? '-'}`,
      });
    }
  }

  // Source.
  if (!policy.sources.includes(transfer.source)) {
    reasons.push({ code: 'SOURCE_NOT_ALLOWED', ...at, account: transfer.source });
  }
  const sourceAccount = snapshot.accounts.get(transfer.source);
  if (sourceAccount === undefined) {
    missing(transfer.source);
  } else {
    const source = sourceAccount === null ? 'does not exist' : tokenAccount(sourceAccount);
    if (typeof source === 'string') {
      reasons.push({
        code: 'SOURCE_ACCOUNT_INVALID',
        ...at,
        account: transfer.source,
        detail: source,
      });
    } else if (source.mint !== transfer.mint || source.owner !== policy.signer) {
      reasons.push({
        code: 'SOURCE_ACCOUNT_INVALID',
        ...at,
        account: transfer.source,
        detail:
          source.mint !== transfer.mint ? 'holds another mint' : 'not owned by the policy signer',
      });
    } else if (source.state === AccountState.Frozen) {
      reasons.push({ code: 'ACCOUNT_FROZEN', ...at, account: transfer.source });
    }
  }

  // Destination.
  let destinationOwner: Address | undefined;
  const destinationAccount = snapshot.accounts.get(transfer.destination);
  if (destinationAccount === undefined) {
    missing(transfer.destination);
  } else if (destinationAccount === null) {
    reasons.push({ code: 'DESTINATION_ACCOUNT_MISSING', ...at, account: transfer.destination });
  } else {
    const destination = tokenAccount(destinationAccount);
    if (typeof destination === 'string') {
      reasons.push({
        code: 'DESTINATION_ACCOUNT_INVALID',
        ...at,
        account: transfer.destination,
        detail: destination,
      });
    } else {
      destinationOwner = destination.owner;
      if (destination.mint !== transfer.mint) {
        reasons.push({ code: 'DESTINATION_MINT_MISMATCH', ...at, account: transfer.destination });
      }
      if (!policy.recipients.owners.includes(destination.owner)) {
        reasons.push({ code: 'RECIPIENT_NOT_ALLOWED', ...at, account: destination.owner });
      }
      if (policy.recipients.requireAssociatedTokenAccount) {
        const [expected] = await findAssociatedTokenPda({
          owner: destination.owner,
          mint: transfer.mint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        if (expected !== transfer.destination) {
          reasons.push({
            code: 'DESTINATION_NOT_ASSOCIATED_TOKEN_ACCOUNT',
            ...at,
            account: transfer.destination,
          });
        }
      }
      if (destination.state === AccountState.Frozen) {
        reasons.push({ code: 'ACCOUNT_FROZEN', ...at, account: transfer.destination });
      }
    }
  }

  if (transfer.amount === 0n) reasons.push({ code: 'ZERO_AMOUNT', ...at });
  return { ...transfer, destinationOwner };
}

function checkFees(
  message: DecodedTransactionMessage,
  policy: Policy,
  reasons: Reason[],
): FeeSummary {
  const { fees } = message;
  const limit = fees.computeUnitLimit;
  let summary: FeeSummary;
  if (fees.source === 'transactionConfig') {
    summary = {
      source: 'transactionConfig',
      computeUnitLimit: limit,
      computeUnitPriceMicroLamports: undefined,
      priorityFeeLamports: fees.priorityFeeLamports,
      loadedAccountsDataSizeLimit: fees.loadedAccountsDataSizeLimit,
      heapSize: fees.heapSize,
    };
  } else {
    const price = fees.computeUnitPriceMicroLamports ?? 0n;
    const units = BigInt(limit ?? ASSUMED_COMPUTE_UNIT_LIMIT);
    summary = {
      source: 'instructions',
      computeUnitLimit: limit,
      computeUnitPriceMicroLamports: fees.computeUnitPriceMicroLamports,
      priorityFeeLamports: (units * price + 999_999n) / 1_000_000n,
      loadedAccountsDataSizeLimit: undefined,
      heapSize: undefined,
    };
  }
  if (limit === undefined && policy.fees.requireExplicitComputeUnitLimit) {
    reasons.push({ code: 'COMPUTE_UNIT_LIMIT_MISSING' });
  }
  // Only a limit the message sets is compared with the cap; an absent one only raises the assumed fee.
  if (limit !== undefined && limit > policy.fees.maxComputeUnitLimit) {
    reasons.push({
      code: 'COMPUTE_UNIT_LIMIT_EXCEEDED',
      detail: `${limit} > ${policy.fees.maxComputeUnitLimit}`,
    });
  }
  if (summary.priorityFeeLamports > policy.fees.maxPriorityFeeLamports) {
    reasons.push({
      code: 'FEE_CAP_EXCEEDED',
      detail: `${summary.priorityFeeLamports} > ${policy.fees.maxPriorityFeeLamports} lamports`,
    });
  }
  return summary;
}

/**
 * Decodes a transaction message and evaluates it against a policy and a
 * snapshot. Pure: no network calls. Returns every failing reason.
 */
export async function review(input: ReviewInput): Promise<ReviewDecision> {
  const { messageBytes, policy, snapshot } = input;
  const base = {
    messageDigest: sha256Hex(messageBytes),
    policyDigest: policyDigest(policy),
    policyId: policy.policyId,
    snapshotSlot: snapshot.slot,
  };

  const decoded = decodeTransactionMessage(messageBytes, snapshot);
  if (!decoded.ok) {
    return {
      ...base,
      outcome: 'deny',
      reasons: decoded.reasons,
      version: decoded.version,
      feePayer: undefined,
      requiredSigners: [],
      lifetime: undefined,
      transfers: [],
      totals: [],
      fees: undefined,
      lookupTableEntries: [],
    };
  }

  const message = decoded.value;
  const reasons: Reason[] = [];

  if (!policy.messageVersions.includes(message.version)) {
    reasons.push({ code: 'VERSION_NOT_ALLOWED', detail: message.version });
  }
  if (!policy.feePayers.includes(message.feePayer)) {
    reasons.push({ code: 'FEE_PAYER_NOT_ALLOWED', account: message.feePayer });
  }
  const allowedSigners = new Set<Address>([policy.signer, ...policy.feePayers]);
  for (const signer of message.requiredSigners) {
    if (!allowedSigners.has(signer)) reasons.push({ code: 'UNEXPECTED_SIGNER', account: signer });
  }
  if (!message.requiredSigners.includes(policy.signer)) {
    reasons.push({ code: 'SIGNER_NOT_REQUIRED', account: policy.signer });
  }
  const nonceAdvance = message.instructions.find(
    (ix) => ix.program === 'system' && ix.advancesNonce,
  );
  if (nonceAdvance !== undefined) {
    reasons.push({ code: 'DURABLE_NONCE_NOT_ALLOWED', path: nonceAdvance.path });
  }

  checkInstructions(message, policy, reasons);

  const transfers: ReviewedTransfer[] = [];
  for (const transfer of message.transfers) {
    transfers.push(await checkTransfer(transfer, message, policy, snapshot, reasons));
  }

  // Totals per mint, top level and inside batch together.
  const totals = new Map<Address, bigint>();
  for (const transfer of message.transfers) {
    totals.set(transfer.mint, (totals.get(transfer.mint) ?? 0n) + transfer.amount);
  }
  let needsApproval = false;
  for (const [mint, total] of totals) {
    const rule = policy.mints.get(mint);
    if (rule === undefined) continue;
    if (total > rule.maxPerTransaction) {
      reasons.push({
        code: 'PER_TRANSACTION_LIMIT_EXCEEDED',
        account: mint,
        detail: `${total} > ${rule.maxPerTransaction}`,
      });
    }
    if (rule.approvalAbove !== undefined && total > rule.approvalAbove) needsApproval = true;
  }

  const fees = checkFees(message, policy, reasons);

  const outcome: Outcome = reasons.length > 0 ? 'deny' : needsApproval ? 'needs_approval' : 'allow';
  return {
    ...base,
    outcome,
    reasons,
    version: message.version,
    feePayer: message.feePayer,
    requiredSigners: message.requiredSigners,
    lifetime: message.lifetime,
    transfers,
    totals: [...totals].map(([mint, amount]) => ({ mint, amount })),
    fees,
    lookupTableEntries: message.lookupTableEntries,
  };
}
