// facilitator.ts on 127.0.0.1:4020: the @x402/svm facilitator scheme wrapped
// with our verifier. Serves /supported (exact on devnet), /verify and /settle.
import express, { type Express } from 'express';
import {
  type MessagePartialSigner,
  type TransactionPartialSigner,
  createSolanaRpc,
} from '@solana/kit';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { toFacilitatorSvmSigner } from '@x402/svm';
import { ExactSvmScheme as FacilitatorScheme } from '@x402/svm/exact/facilitator';

import {
  type PolicyNetwork,
  type X402VerifierConfig,
  type X402VerifierDecision,
  createRpcSnapshotLoader,
} from '@nexbridge/solana-signing-firewall';
import { withX402Verifier } from '@nexbridge/solana-signing-firewall-x402';

import { DEVNET } from './net.js';

/**
 * The local facilitator: the @x402/svm facilitator scheme wrapped with our
 * verifier, serving /supported, /verify and /settle.
 */
export function facilitatorApp(options: {
  /** The facilitator's own key; it signs only payments the verifier accepted. */
  readonly feePayer: TransactionPartialSigner & MessagePartialSigner;
  readonly rpcUrl: string;
  readonly config: X402VerifierConfig;
  readonly loaderNetwork: PolicyNetwork;
  readonly onDecision?: (decision: X402VerifierDecision) => void;
  readonly onSettle?: (result: unknown) => void;
}): Express {
  const signer = toFacilitatorSvmSigner(options.feePayer, { defaultRpcUrl: options.rpcUrl });
  const inner = new FacilitatorScheme(signer, undefined, { transactionVersions: [0, 1] });
  const scheme = withX402Verifier(inner, {
    config: options.config,
    loader: createRpcSnapshotLoader(createSolanaRpc(options.rpcUrl)),
    network: options.loaderNetwork,
    ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
  });
  const facilitator = new x402Facilitator().register(DEVNET, scheme);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get('/supported', (_req, res) => {
    res.json(facilitator.getSupported());
  });
  app.post('/verify', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  });
  app.post('/settle', async (req, res) => {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    options.onSettle?.(result);
    res.json(result);
  });
  return app;
}
