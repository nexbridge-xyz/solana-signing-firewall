// Security review: no private key in the repository or anywhere in its history.
//
// A secret scanner that works from field names does not see an Ed25519 key that sits under a
// neutral name: a 64-byte "secret key" in base58 looks exactly like a transaction signature, and
// a 32-byte seed looks exactly like an address or a blockhash. A key can be told apart by what it
// is, though:
//   - a 64-byte value is a key pair exactly when its last 32 bytes are the public key of its
//     first 32 bytes;
//   - a 32-byte value is the seed of a known account exactly when the address derived from it
//     appears somewhere in the repository (the demo's addresses are all in the run record).
// This test applies both to every commit reachable from any ref. It reads the local git
// history only.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function publicKeyOf(seed: Uint8Array): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return new Uint8Array(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
}

const isKeyPair = (bytes: Uint8Array) =>
  bytes.length === 64 &&
  Buffer.from(publicKeyOf(bytes.subarray(0, 32))).equals(Buffer.from(bytes.subarray(32)));

function base58Bytes(text: string): Uint8Array | undefined {
  try {
    return new Uint8Array(getBase58Encoder().encode(text));
  } catch {
    return undefined;
  }
}

/** What the scan found in a body of text. Counts only; no value is ever returned or printed. */
export function scan(text: string) {
  const sixtyFour: Uint8Array[] = [];
  const thirtyTwo = new Map<string, Uint8Array>();
  for (const candidate of new Set(text.match(/[1-9A-HJ-NP-Za-km-z]{32,90}/g) ?? [])) {
    const bytes = base58Bytes(candidate);
    if (bytes?.length === 64) sixtyFour.push(bytes);
    if (bytes?.length === 32) thirtyTwo.set(candidate, bytes);
  }
  for (const candidate of new Set(text.match(/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g) ?? [])) {
    sixtyFour.push(Uint8Array.from(JSON.parse(candidate) as number[]));
  }
  const hexSeeds: Uint8Array[] = [];
  for (const candidate of new Set(text.match(/\b[0-9a-fA-F]{64,128}\b/g) ?? [])) {
    if (candidate.length === 128) sixtyFour.push(Uint8Array.from(Buffer.from(candidate, 'hex')));
    if (candidate.length === 64) hexSeeds.push(Uint8Array.from(Buffer.from(candidate, 'hex')));
  }
  const seedsOfKnownAddresses = [...thirtyTwo.values(), ...hexSeeds].filter((seed) =>
    thirtyTwo.has(getBase58Decoder().decode(publicKeyOf(seed))),
  ).length;
  return {
    values64: sixtyFour.length,
    values32: thirtyTwo.size + hexSeeds.length,
    keyPairs: sixtyFour.filter(isKeyPair).length,
    seedsOfKnownAddresses,
  };
}

describe('private keys in the repository and its history', () => {
  it('the scan recognizes a key pair and a seed in every form, and not a signature (control)', () => {
    // A throwaway key made for this test run. It exists nowhere else.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const seed = new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
    const publicBytes = new Uint8Array(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    );
    const secret = new Uint8Array([...seed, ...publicBytes]);
    const address = getBase58Decoder().decode(publicBytes);
    const b58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

    expect(scan(`{"signature": "${b58(secret)}"}`).keyPairs).toBe(1);
    expect(scan(`treasury: [${[...secret].join(', ')}]`).keyPairs).toBe(1);
    expect(scan(`KEY=${Buffer.from(secret).toString('hex')}`).keyPairs).toBe(1);
    expect(scan(`"token": "${b58(seed)}", "treasury": "${address}"`).seedsOfKnownAddresses).toBe(1);
    expect(
      scan(`seed ${Buffer.from(seed).toString('hex')} for ${address}`).seedsOfKnownAddresses,
    ).toBe(1);
    // 64 random bytes (a signature has no such structure) and an address alone are not keys.
    const noise = scan(
      `"signature": "${b58(crypto.getRandomValues(new Uint8Array(64)))}" ${address}`,
    );
    expect([noise.keyPairs, noise.seedsOfKnownAddresses]).toEqual([0, 0]);
  });

  it('holds no key pair and no seed of a known address, in any commit', () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });
    // A shallow clone holds only part of the history, and the scan would pass on what is left.
    // CI checks out every commit (fetch-depth: 0); anywhere else, fetch the history first.
    expect(git(['rev-parse', '--is-shallow-repository']).trim()).toBe('false');
    const history = git(['log', '--all', '-p', '--format=commit %H']);
    const commits = Number(git(['rev-list', '--all', '--count']).trim());
    expect(commits).toBeGreaterThan(1);
    expect(history.match(/^commit [0-9a-f]{40}$/gm)?.length).toBe(commits);
    const found = scan(history);
    // The history does hold 64-byte and 32-byte values (signatures, addresses, blockhashes):
    // the scan had something to look at.
    expect(found.values64).toBeGreaterThan(0);
    expect(found.values32).toBeGreaterThan(0);
    expect({ keyPairs: found.keyPairs, seeds: found.seedsOfKnownAddresses }).toEqual({
      keyPairs: 0,
      seeds: 0,
    });
  }, 120_000);
});
