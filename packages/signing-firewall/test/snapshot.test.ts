import { describe, expect, it } from 'vitest';
import { type Address, address } from '@solana/kit';

import {
  type Snapshot,
  type SnapshotAccount,
  snapshotFromJson,
  snapshotToJson,
} from '../src/index.js';

const A = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const B = address('11111111111111111111111111111111');

describe('snapshot JSON', () => {
  it('round-trips, keeps "fetched and absent" apart from "not fetched", and sorts addresses', () => {
    const snapshot: Snapshot = {
      slot: 1234n,
      accounts: new Map<Address, SnapshotAccount | null>([
        [A, { owner: B, lamports: 2_039_280n, data: Uint8Array.of(1, 2, 3), executable: false }],
        [B, null],
      ]),
    };
    const json = snapshotToJson(snapshot);
    expect(json.slot).toBe('1234');
    expect(Object.keys(json.accounts)).toEqual([B, A].sort());
    expect(json.accounts[B]).toBeNull();
    expect(json.accounts[A]).toEqual({
      owner: B,
      lamports: '2039280',
      data: 'AQID',
      executable: false,
    });
    expect(snapshotFromJson(json)).toEqual(snapshot);
  });
});
