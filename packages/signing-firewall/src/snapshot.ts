import { type Address, address, getBase64Decoder, getBase64Encoder } from '@solana/kit';

/** One account as fetched from RPC at `Snapshot.slot`. */
export type SnapshotAccount = {
  readonly owner: Address;
  readonly lamports: bigint;
  readonly data: Uint8Array;
  readonly executable: boolean;
};

/**
 * The on-chain state an evaluation is allowed to see. `review()` never makes
 * network calls; a loader builds this snapshot over RPC beforehand. Address
 * lookup tables are ordinary accounts in `accounts`.
 */
export type Snapshot = {
  readonly slot: bigint;
  readonly accounts: ReadonlyMap<Address, SnapshotAccount>;
};

/** JSON form used by the public test vectors. u64 values are decimal strings. */
export type SnapshotJson = {
  slot: string;
  accounts: Record<string, { owner: string; lamports: string; data: string; executable: boolean }>;
};

export function snapshotFromJson(json: SnapshotJson): Snapshot {
  const accounts = new Map<Address, SnapshotAccount>();
  for (const [key, value] of Object.entries(json.accounts)) {
    accounts.set(address(key), {
      owner: address(value.owner),
      lamports: BigInt(value.lamports),
      data: new Uint8Array(getBase64Encoder().encode(value.data)),
      executable: value.executable,
    });
  }
  return { slot: BigInt(json.slot), accounts };
}

export function snapshotToJson(snapshot: Snapshot): SnapshotJson {
  const accounts: SnapshotJson['accounts'] = {};
  for (const key of [...snapshot.accounts.keys()].sort()) {
    const value = snapshot.accounts.get(key);
    if (value === undefined) continue;
    accounts[key] = {
      owner: value.owner,
      lamports: value.lamports.toString(),
      data: getBase64Decoder().decode(value.data),
      executable: value.executable,
    };
  }
  return { slot: snapshot.slot.toString(), accounts };
}
