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

/**
 * Public RPC endpoints answer HTTP 429 under load. For requests to `rpcUrl` only, this waits and
 * sends the same request again, at most 5 times (after 1, 2, 4, 8 and 16 seconds). It never
 * repeats `requestAirdrop`. Repeating `sendTransaction` is safe: the bytes and so the signature
 * are the same, and the cluster processes a signature once. Kit's HTTP transport calls the global
 * `fetch`, so this covers every RPC client in the process, the x402 SDK's included. Returns a
 * function that restores the original `fetch`. The URL is never printed.
 */
export function retryRpcOnRateLimit(rpcUrl: string, log?: (line: string) => void): () => void {
  const original = globalThis.fetch;
  const target = new URL(rpcUrl);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = typeof init?.body === 'string' ? init.body : '';
    const repeatable =
      url.origin === target.origin &&
      url.pathname === target.pathname &&
      !/"method"\s*:\s*"requestAirdrop"/.test(body);
    for (let attempt = 0; ; attempt += 1) {
      const response = await original(input, init);
      if (!repeatable || response.status !== 429 || attempt >= 5) return response;
      const seconds = 2 ** attempt;
      log?.(
        `  (the RPC answered 429 Too Many Requests; sending the same request again in ${String(seconds)} s)`,
      );
      await sleep(seconds * 1000);
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}

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
    await sleep(1000);
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
