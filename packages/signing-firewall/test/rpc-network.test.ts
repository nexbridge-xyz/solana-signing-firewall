import { describe, expect, it } from 'vitest';
import type { GetGenesisHashApi, Rpc } from '@solana/kit';

import { NetworkMismatchError, assertRpcNetwork } from '../src/index.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function fakeRpc(genesisHash: string) {
  const counter = { calls: 0 };
  const rpc = {
    getGenesisHash: () => ({
      send: () => {
        counter.calls += 1;
        return Promise.resolve(genesisHash);
      },
    }),
  } as unknown as Rpc<GetGenesisHashApi>;
  return { rpc, counter };
}

describe('assertRpcNetwork', () => {
  it('accepts an RPC that serves the policy network', async () => {
    await expect(assertRpcNetwork(fakeRpc(DEVNET_GENESIS).rpc, 'devnet')).resolves.toBeUndefined();
  });

  it('refuses an RPC that serves another cluster', async () => {
    const { rpc } = fakeRpc('NotDevnet1111111111111111111111111111111111');
    await expect(assertRpcNetwork(rpc, 'devnet')).rejects.toBeInstanceOf(NetworkMismatchError);
    await expect(assertRpcNetwork(fakeRpc(DEVNET_GENESIS).rpc, 'testnet')).rejects.toThrow(
      /not the policy network "testnet"/,
    );
  });

  it('sends no request for localnet', async () => {
    const { rpc, counter } = fakeRpc('anything');
    await assertRpcNetwork(rpc, 'localnet');
    expect(counter.calls).toBe(0);
  });
});
