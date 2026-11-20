import { describe, expect, it } from 'vitest';
import {
  type Address,
  type KeyPairSigner,
  type TransactionPartialSigner,
  appendTransactionMessageInstructions,
  createClient,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  lamports,
  signBytes,
  signTransactionMessageWithSigners,
  type SignatureBytes,
} from '@solana/kit';
import { assertIsSolanaTransactionSigner, createKeychainSigner } from '@solana/keychain';
import { createMemorySigner } from '@solana/keychain-memory';
import { litesvm } from '@solana/kit-plugin-litesvm';
import { signer as signerPlugin } from '@solana/kit-plugin-signer';
import { getTransferCheckedInstruction } from '@solana-program/token';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';

import {
  type ApprovalRecord,
  PolicyViolationError,
  type SnapshotLoader,
  TOKEN_PROGRAM_ADDRESS,
  createApproval,
  createRpcSnapshotLoader,
  review,
  staticSnapshotLoader,
  withPolicy,
} from '../src/index.js';
import {
  mintData,
  policyFor,
  snapshotFor,
  testWorld,
  tokenData,
  transferTransaction,
} from './world.js';
import { BLOCKHASH } from './helpers.js';

const w = await testWorld();
const policy = policyFor(w);
const loader = staticSnapshotLoader(snapshotFor(w));
const now = () => new Date('2026-11-20T00:00:00.000Z');

/** Counts calls and optionally misbehaves. */
function spy(inner: KeyPairSigner, behavior: 'honest' | 'other-bytes' | 'extra-signer' = 'honest') {
  let calls = 0;
  const signer: TransactionPartialSigner = {
    address: inner.address,
    async signTransactions(transactions) {
      calls += 1;
      if (behavior === 'honest') return inner.signTransactions(transactions);
      return Promise.all(
        transactions.map(async (tx) => {
          const bytes = new Uint8Array(tx.messageBytes);
          if (behavior === 'other-bytes')
            bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
          const signature = await signBytes(inner.keyPair.privateKey, bytes);
          const dictionary: Record<Address, SignatureBytes> = { [inner.address]: signature };
          if (behavior === 'extra-signer') dictionary[w.outsider.address] = signature;
          return dictionary;
        }),
      );
    },
  };
  return { signer, calls: () => calls };
}

async function refusal(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolicyViolationError) return error.reasons.map((r) => r.code);
    throw error;
  }
  return [];
}

describe('withPolicy', () => {
  it('signs an allowed transaction and returns a valid signature', async () => {
    const inner = spy(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const [signatures] = await wrapped.signTransactions([transferTransaction(w, 1_000_000n)]);
    expect(Object.keys(signatures ?? {})).toEqual([w.treasury.address]);
    expect(inner.calls()).toBe(1);
  });

  it('never calls the inner signer for a denied transaction', async () => {
    const inner = spy(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    expect(await refusal(wrapped.signTransactions([transferTransaction(w, 6_000_000n)]))).toEqual([
      'PER_TRANSACTION_LIMIT_EXCEEDED',
    ]);
    expect(inner.calls()).toBe(0);
  });

  it('reviews every transaction before signing any of them', async () => {
    const inner = spy(w.treasury);
    const wrapped = withPolicy(inner.signer, { policy, loader, now });
    const batch = [transferTransaction(w, 1_000_000n), transferTransaction(w, 6_000_000n)];
    expect(await refusal(wrapped.signTransactions(batch))).toEqual([
      'PER_TRANSACTION_LIMIT_EXCEEDED',
    ]);
    expect(inner.calls()).toBe(0);
  });

  it('needs an approval above the threshold, and accepts only one for these bytes', async () => {
    const approved = transferTransaction(w, 3_000_000n);
    const changed = transferTransaction(w, 4_500_000n);
    const decision = await review({
      messageBytes: new Uint8Array(approved.messageBytes),
      policy,
      snapshot: snapshotFor(w),
      now: now(),
    });
    const record = await createApproval({
      decision,
      approver: w.approver,
      issuedAt: new Date(now().getTime() - 5_000),
      expiresAt: new Date(now().getTime() + 60_000),
    });
    const approvals = new Map<string, ApprovalRecord>([[record.messageDigest, record]]);

    const inner = spy(w.treasury);
    const noApprovals = withPolicy(inner.signer, { policy, loader, now });
    expect(await refusal(noApprovals.signTransactions([approved]))).toEqual(['APPROVAL_REQUIRED']);

    // The changed message presented with the earlier approval (scene 6).
    const replay = withPolicy(inner.signer, { policy, loader, now, approvals: () => record });
    expect(await refusal(replay.signTransactions([changed]))).toEqual([
      'APPROVAL_MESSAGE_MISMATCH',
    ]);
    expect(inner.calls()).toBe(0);

    const byDigest = withPolicy(inner.signer, {
      policy,
      loader,
      now,
      approvals: (d) => approvals.get(d),
    });
    await byDigest.signTransactions([approved]);
    expect(inner.calls()).toBe(1);
  });

  it('rejects a signature over other bytes (a signer that rewrites the message)', async () => {
    const wrapped = withPolicy(spy(w.treasury, 'other-bytes').signer, { policy, loader, now });
    expect(await refusal(wrapped.signTransactions([transferTransaction(w, 1_000_000n)]))).toEqual([
      'SIGNATURE_INVALID',
    ]);
  });

  it('rejects a result that carries signatures by anyone else', async () => {
    const wrapped = withPolicy(spy(w.treasury, 'extra-signer').signer, { policy, loader, now });
    expect(await refusal(wrapped.signTransactions([transferTransaction(w, 1_000_000n)]))).toEqual([
      'SIGNATURE_INVALID',
    ]);
  });

  it('refuses at construction a signer for another address, or one that cannot partially sign', () => {
    const otherSigner = spy(w.outsider).signer;
    expect(() => withPolicy(otherSigner, { policy, loader })).toThrow(/SIGNER_ADDRESS_MISMATCH/);
    const sending = {
      address: w.treasury.address,
      signAndSendTransactions: () => Promise.resolve([]),
    };
    expect(() =>
      withPolicy(sending as unknown as TransactionPartialSigner, { policy, loader }),
    ).toThrow(/UNSUPPORTED_INNER_SIGNER/);
  });

  it('exposes no message signing, and delegates isAvailable()', async () => {
    const inner = await createMemorySigner({ keyPair: w.treasury.keyPair });
    const wrapped = withPolicy(inner, { policy, loader, now });
    expect('signMessages' in wrapped).toBe(false);
    expect(await wrapped.isAvailable()).toBe(true);
  });

  it('wraps a Keychain memory signer and passes the Keychain signer shape check', async () => {
    const inner = await createKeychainSigner({ backend: 'memory', keyPair: w.treasury.keyPair });
    const wrapped = withPolicy(inner, { policy, loader, now });
    expect(() => {
      assertIsSolanaTransactionSigner(wrapped);
    }).not.toThrow();
    const [signatures] = await wrapped.signTransactions([transferTransaction(w, 1_000_000n)]);
    expect(Object.keys(signatures ?? {})).toEqual([w.treasury.address]);
  });

  it('signs through signTransactionMessageWithSigners', async () => {
    const wrapped = withPolicy(await createMemorySigner({ keyPair: w.treasury.keyPair }), {
      policy,
      loader,
      now,
    });
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(wrapped, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 0n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: 30_000 }),
            getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
            getTransferCheckedInstruction({
              source: w.treasuryAta,
              mint: w.mint,
              destination: w.vendorAta,
              authority: wrapped,
              amount: 1_000_000n,
              decimals: 6,
            }),
          ],
          m,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    expect(Object.keys(signed.signatures)).toEqual([w.treasury.address]);
  });

  it('sends through a Kit client in LiteSVM, with state loaded over the client RPC', async () => {
    const inner = await createKeychainSigner({ backend: 'memory', keyPair: w.treasury.keyPair });
    const relaxed = policyFor(w, {
      fees: {
        maxComputeUnitLimit: 1_400_000,
        maxPriorityFeeLamports: '1000000',
        requireExplicitComputeUnitLimit: false,
      },
    });
    // The client is created first so the wrapper can load state through its RPC.
    const holder: { loader?: SnapshotLoader } = {};
    const lazyLoader: SnapshotLoader = {
      load: (bytes, options) => {
        if (holder.loader === undefined) throw new Error('loader not ready');
        return holder.loader.load(bytes, options);
      },
    };
    const decisions: string[] = [];
    const wrapped = withPolicy(inner, {
      policy: relaxed,
      loader: lazyLoader,
      now,
      onDecision: (d) => {
        decisions.push(d.outcome);
      },
    });
    const client = createClient().use(signerPlugin(wrapped)).use(litesvm());
    holder.loader = createRpcSnapshotLoader(client.rpc as never);

    client.svm.airdrop(w.treasury.address, lamports(1_000_000_000n));
    const put = (address: Address, data: Uint8Array) => {
      client.svm.setAccount({
        address,
        data,
        executable: false,
        lamports: lamports(2_039_280n),
        programAddress: TOKEN_PROGRAM_ADDRESS,
        space: BigInt(data.length),
      });
    };
    put(w.mint, mintData());
    put(w.treasuryAta, tokenData(w.mint, w.treasury.address, 10_000_000n));
    put(w.vendorAta, tokenData(w.mint, w.vendor.address, 0n));

    await client.sendTransaction([
      getTransferCheckedInstruction({
        source: w.treasuryAta,
        mint: w.mint,
        destination: w.vendorAta,
        authority: wrapped,
        amount: 1_500_000n,
        decimals: 6,
      }),
    ]);
    expect(decisions).toEqual(['allow']);
    const vendorAccount = client.svm.getAccount(w.vendorAta);
    expect(vendorAccount.exists ? vendorAccount.data.length : 0).toBe(165);

    await expect(
      client.sendTransaction([
        getTransferCheckedInstruction({
          source: w.treasuryAta,
          mint: w.mint,
          destination: w.vendorAta,
          authority: wrapped,
          amount: 6_000_000n,
          decimals: 6,
        }),
      ]),
    ).rejects.toThrow();
    expect(decisions).toEqual(['allow', 'deny']);
  });
});

describe('createRpcSnapshotLoader', () => {
  type Call = { method: string; addresses?: readonly Address[] };
  function fakeRpc(genesis: string, accounts: Map<Address, Uint8Array>) {
    const calls: Call[] = [];
    const rpc = {
      getGenesisHash: () => ({
        send: () => {
          calls.push({ method: 'getGenesisHash' });
          return Promise.resolve(genesis);
        },
      }),
      getMultipleAccounts: (addresses: readonly Address[]) => ({
        send: () => {
          calls.push({ method: 'getMultipleAccounts', addresses });
          return Promise.resolve({
            context: { slot: 77n },
            value: addresses.map((a) => {
              const data = accounts.get(a);
              return data === undefined
                ? null
                : {
                    data: [Buffer.from(data).toString('base64'), 'base64'],
                    owner: TOKEN_PROGRAM_ADDRESS,
                    lamports: 2_039_280n,
                    executable: false,
                  };
            }),
          });
        },
      }),
    };
    return { rpc: rpc as never, calls };
  }

  const bytes = new Uint8Array(transferTransaction(w, 1_000_000n).messageBytes);
  const known = new Map<Address, Uint8Array>([
    [w.mint, mintData()],
    [w.treasuryAta, tokenData(w.mint, w.treasury.address, 1n)],
  ]);

  it('fetches the transfer accounts and records the missing one as null', async () => {
    const { rpc, calls } = fakeRpc('EtWTRABZaYq6iMfeYKouRu166VU2xqa1zzzz', known);
    const snapshot = await createRpcSnapshotLoader(rpc).load(bytes, { network: 'devnet' });
    expect(snapshot.slot).toBe(77n);
    expect(snapshot.accounts.get(w.vendorAta)).toBeNull();
    expect(snapshot.accounts.get(w.mint)?.data).toEqual(mintData());
    expect(calls.map((c) => c.method)).toEqual(['getGenesisHash', 'getMultipleAccounts']);
  });

  it('refuses an RPC for another cluster', async () => {
    const { rpc } = fakeRpc('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpzzzz', known);
    await expect(createRpcSnapshotLoader(rpc).load(bytes, { network: 'devnet' })).rejects.toThrow(
      /genesis/,
    );
  });

  it('returns an empty snapshot for bytes that do not decode', async () => {
    const { rpc, calls } = fakeRpc('x', known);
    const snapshot = await createRpcSnapshotLoader(rpc).load(new Uint8Array([1, 2, 3]), {
      network: 'localnet',
    });
    expect(snapshot.accounts.size).toBe(0);
    expect(calls).toEqual([]);
  });
});
