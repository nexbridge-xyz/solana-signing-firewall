// Checks what the bundled LiteSVM runtime supports before we rely on it:
// a P-Token `batch` instruction, and a version-1 transaction.
import { describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getBatchInstruction,
  getMintEncoder,
  getTokenDecoder,
  getTokenEncoder,
  getTransferCheckedInstruction,
} from '@solana-program/token';

type Env = {
  svm: LiteSVM;
  owner: KeyPairSigner;
  mint: Address;
  source: Address;
  destinations: Address[];
};

function putAccount(svm: LiteSVM, address: Address, data: Uint8Array): void {
  svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space: BigInt(data.length),
  });
}

async function tokenAccount(svm: LiteSVM, mint: Address, owner: Address, amount: bigint) {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const data = getTokenEncoder().encode({
    mint,
    owner,
    amount,
    delegate: null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
  });
  putAccount(svm, ata, new Uint8Array(data));
  return ata;
}

async function setup(): Promise<Env> {
  const svm = new LiteSVM();
  const owner = await generateKeyPairSigner();
  svm.airdrop(owner.address, lamports(1_000_000_000n));
  const mint = (await generateKeyPairSigner()).address;
  const mintData = getMintEncoder().encode({
    mintAuthority: null,
    supply: 10_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  });
  putAccount(svm, mint, new Uint8Array(mintData));
  const source = await tokenAccount(svm, mint, owner.address, 10_000_000n);
  const destinations = [
    await tokenAccount(svm, mint, (await generateKeyPairSigner()).address, 0n),
    await tokenAccount(svm, mint, (await generateKeyPairSigner()).address, 0n),
  ];
  return { svm, owner, mint, source, destinations };
}

function transfer(env: Env, destination: Address, amount: bigint) {
  return getTransferCheckedInstruction({
    source: env.source,
    mint: env.mint,
    destination,
    authority: env.owner,
    amount,
    decimals: 6,
  });
}

function balance(env: Env, account: Address): bigint {
  const found = env.svm.getAccount(account);
  if (!found.exists) throw new Error(`missing ${account}`);
  return getTokenDecoder().decode(found.data).amount;
}

async function sendLegacy(env: Env, instructions: Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 'legacy' }),
    (m) => setTransactionMessageFeePayerSigner(env.owner, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: env.svm.latestBlockhash(), lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return env.svm.sendTransaction(await signTransactionMessageWithSigners(message));
}

async function sendV1(env: Env, instructions: Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(env.owner, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: env.svm.latestBlockhash(), lastValidBlockHeight: 0n },
        m,
      ),
    (m) =>
      setTransactionMessageConfig(
        {
          computeUnitLimit: 200_000,
          loadedAccountsDataSizeLimit: 4_194_304,
          priorityFeeLamports: 1_000n,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return env.svm.sendTransaction(await signTransactionMessageWithSigners(message));
}

describe('LiteSVM capabilities', () => {
  it('executes a P-Token batch with two TransferChecked entries', async () => {
    const env = await setup();
    const [a, b] = env.destinations as [Address, Address];
    const result = await sendLegacy(env, [
      getBatchInstruction([transfer(env, a, 400_000n), transfer(env, b, 600_000n)]),
    ]);
    expect(result instanceof FailedTransactionMetadata ? result.toString() : 'ok').toBe('ok');
    expect(balance(env, a)).toBe(400_000n);
    expect(balance(env, b)).toBe(600_000n);
    expect(balance(env, env.source)).toBe(9_000_000n);
  });

  it('executes a version-1 transaction whose fees live in transactionConfig', async () => {
    const env = await setup();
    const [a] = env.destinations as [Address];
    const result = await sendV1(env, [transfer(env, a, 500_000n)]);
    expect(result instanceof FailedTransactionMetadata ? result.toString() : 'ok').toBe('ok');
    expect(balance(env, a)).toBe(500_000n);
  });
});
