// Scene 15: a payment signed with the agent key outside the guard, whose token
// instruction is ApproveChecked. It is posted straight to the facilitator's
// /verify. This script never calls /settle, and the bytes never reach a cluster.
import {
  type Address,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { getApproveCheckedInstruction } from '@solana-program/token';
import type { PaymentRequirements, VerifyResponse } from '@x402/core/types';

import { SPL_MEMO_PROGRAM_ADDRESS } from '@nexbridge/solana-signing-firewall';

export async function forgedPayment(options: {
  readonly agent: KeyPairSigner;
  readonly feePayer: Address;
  readonly mint: Address;
  readonly agentAta: Address;
  readonly delegate: Address;
  readonly amount: bigint;
  readonly blockhash: Blockhash;
}): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(options.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: options.blockhash, lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 20_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1n }),
          getApproveCheckedInstruction({
            source: options.agentAta,
            mint: options.mint,
            delegate: options.delegate,
            owner: options.agent,
            amount: options.amount,
            decimals: 6,
          }),
          {
            programAddress: SPL_MEMO_PROGRAM_ADDRESS,
            data: new TextEncoder().encode('f'.repeat(32)),
          },
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

export async function postToVerify(
  facilitatorUrl: string,
  transaction: string,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  const response = await fetch(`${facilitatorUrl}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction } },
      paymentRequirements: requirements,
    }),
  });
  return (await response.json()) as VerifyResponse;
}
