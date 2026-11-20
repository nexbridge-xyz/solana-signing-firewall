import {
  type Address,
  type Commitment,
  type GetGenesisHashApi,
  type GetMultipleAccountsApi,
  type Rpc,
  getBase64Encoder,
} from '@solana/kit';

import { classifyInstruction } from '../decode/classify.js';
import { decodeCompiledMessage } from '../decode/compiled.js';
import { resolveMessage } from '../decode/resolve.js';
import type { PolicyNetwork } from '../policy.js';
import type { Snapshot, SnapshotAccount } from '../snapshot.js';

/** Builds the snapshot `review()` evaluates a message against. */
export type SnapshotLoader = {
  load(messageBytes: Uint8Array, options: { readonly network: PolicyNetwork }): Promise<Snapshot>;
};

export type LoaderRpc = Rpc<GetMultipleAccountsApi & GetGenesisHashApi>;

/** CAIP-2 references: the first 32 characters of each cluster's genesis hash. */
const GENESIS_PREFIX: Record<Exclude<PolicyNetwork, 'localnet'>, string> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};
const MAX_ACCOUNTS_PER_REQUEST = 100;

export class NetworkMismatchError extends Error {
  constructor(network: PolicyNetwork, genesisHash: string) {
    super(`the RPC serves genesis ${genesisHash}, not the policy network "${network}"`);
    this.name = 'NetworkMismatchError';
  }
}

/**
 * Throws `NetworkMismatchError` unless the RPC's genesis hash belongs to `network`.
 * `localnet` is not checked. Call it before sending anything.
 */
export async function assertRpcNetwork(
  rpc: Rpc<GetGenesisHashApi>,
  network: PolicyNetwork,
): Promise<void> {
  if (network === 'localnet') return;
  const genesisHash = await rpc.getGenesisHash().send();
  if (!genesisHash.startsWith(GENESIS_PREFIX[network])) {
    throw new NetworkMismatchError(network, genesisHash);
  }
}

/**
 * Fetches, in two rounds, the accounts an evaluation needs: first the lookup
 * tables, then each transfer's mint, source and destination. Accounts that do
 * not exist are recorded as `null`. Refuses to run against an RPC whose genesis
 * hash does not match the policy network (`localnet` skips that check).
 */
export function createRpcSnapshotLoader(
  rpc: LoaderRpc,
  config: { readonly commitment?: Commitment } = {},
): SnapshotLoader {
  const commitment = config.commitment ?? 'confirmed';
  const checkedNetworks = new Set<PolicyNetwork>();

  async function fetchAccounts(
    addresses: readonly Address[],
    accounts: Map<Address, SnapshotAccount | null>,
    minContextSlot: bigint,
  ): Promise<bigint> {
    let slot = minContextSlot;
    for (let i = 0; i < addresses.length; i += MAX_ACCOUNTS_PER_REQUEST) {
      const chunk = addresses.slice(i, i + MAX_ACCOUNTS_PER_REQUEST);
      const { context, value } = await rpc
        .getMultipleAccounts(chunk, { encoding: 'base64', commitment, minContextSlot: slot })
        .send();
      slot = context.slot;
      chunk.forEach((address, j) => {
        const account = value[j];
        accounts.set(
          address,
          account === null || account === undefined
            ? null
            : {
                owner: account.owner,
                lamports: account.lamports,
                data: new Uint8Array(getBase64Encoder().encode(account.data[0])),
                executable: account.executable,
              },
        );
      });
    }
    return slot;
  }

  return {
    async load(messageBytes, { network }) {
      if (!checkedNetworks.has(network)) {
        await assertRpcNetwork(rpc, network);
        checkedNetworks.add(network);
      }

      const accounts = new Map<Address, SnapshotAccount | null>();
      const compiled = decodeCompiledMessage(messageBytes);
      // A message that does not decode needs no state; review() reports why.
      if (!compiled.ok) return { slot: 0n, accounts };

      const tables = [
        ...new Set(compiled.value.addressTableLookups.map((l) => l.lookupTableAddress)),
      ];
      let slot = await fetchAccounts(tables, accounts, 0n);

      const resolved = resolveMessage(compiled.value, { slot, accounts });
      if (!resolved.ok) return { slot, accounts };
      const needed = new Set<Address>();
      for (const ix of resolved.value.instructions) {
        const classified = classifyInstruction(ix);
        if (!classified.ok || classified.value.program !== 'spl-token') continue;
        const token = classified.value.token;
        const transfers =
          token.type === 'transfer-checked'
            ? [token.transfer]
            : token.type === 'batch'
              ? token.entries.flatMap((e) =>
                  e.instruction.type === 'transfer-checked' ? [e.instruction.transfer] : [],
                )
              : [];
        for (const t of transfers) [t.mint, t.source, t.destination].forEach((a) => needed.add(a));
      }
      slot = await fetchAccounts([...needed], accounts, slot);
      return { slot, accounts };
    },
  };
}

/** A loader that always returns the same snapshot. For tests and vectors. */
export function staticSnapshotLoader(snapshot: Snapshot): SnapshotLoader {
  return { load: () => Promise.resolve(snapshot) };
}
