// Sending and confirming over plain JSON-RPC (no WebSocket), so the same code
// runs against devnet and against the LiteSVM-backed local RPC.
import {
  type Signature,
  type Transaction,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  devnet,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
} from '@solana/kit';

/**
 * An RPC client for devnet, or for the LiteSVM-backed local RPC in rehearsals.
 * `devnet()` only brands the URL type; the genesis check happens before any send.
 */
export function createDemoRpc(url: string) {
  return createSolanaRpc(devnet(url));
}

export type DemoRpc = ReturnType<typeof createDemoRpc>;

export function explorerLink(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** The explorer link on devnet; nothing for a local rehearsal, which no explorer can show. */
export function explorerFor(network: string, signature: string): { explorer?: string } {
  return network === 'devnet' ? { explorer: explorerLink(signature) } : {};
}

/** How a sent transaction is printed: its explorer link, or the signature when local. */
export function shownLink(network: string, signature: string): string {
  return network === 'devnet' ? explorerLink(signature) : `${signature} (local, no explorer)`;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const jsonWithBigInts = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** Polls the signature status until it is confirmed, and returns its slot. */
export async function waitForConfirmation(
  rpc: DemoRpc,
  signature: Signature,
  timeoutMs = 60_000,
): Promise<bigint> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (
      status !== null &&
      status !== undefined &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    ) {
      if (status.err !== null) {
        throw new Error(`transaction ${signature} failed: ${jsonWithBigInts(status.err)}`);
      }
      return status.slot;
    }
    await sleep(500);
  }
  throw new Error(
    `transaction ${signature} was not confirmed within ${String(timeoutMs / 1000)} s`,
  );
}

/** Sends a signed transaction once and waits for confirmation. No resending. */
export async function sendAndConfirm(
  rpc: DemoRpc,
  transaction: Transaction,
): Promise<{ signature: Signature; slot: bigint }> {
  assertIsTransactionWithinSizeLimit(transaction);
  const signature = getSignatureFromTransaction(transaction);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();
  return { signature, slot: await waitForConfirmation(rpc, signature) };
}
