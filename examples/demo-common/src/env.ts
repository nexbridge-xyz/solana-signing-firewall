// Keys for the demo accounts. They are generated on this machine and live only
// in the key file (the repository's `.env`, which git ignores). Nothing in this
// module prints or logs a key, and no error message carries one.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes,
  getBase58Decoder,
  getBase58Encoder,
} from '@solana/kit';

export const ROLES = [
  'treasury',
  'approver',
  'vendorA',
  'vendorB',
  'outsider',
  'agent',
  'shop',
  'facilitatorFeePayer',
] as const;
export type Role = (typeof ROLES)[number];

export const KEY_VARIABLES: Record<Role, string> = {
  treasury: 'TREASURY_SECRET_KEY',
  approver: 'APPROVER_SECRET_KEY',
  vendorA: 'VENDOR_A_SECRET_KEY',
  vendorB: 'VENDOR_B_SECRET_KEY',
  outsider: 'OUTSIDER_SECRET_KEY',
  agent: 'AGENT_SECRET_KEY',
  shop: 'SHOP_SECRET_KEY',
  facilitatorFeePayer: 'FACILITATOR_FEE_PAYER_SECRET_KEY',
};

export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

const LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (match?.[1] !== undefined) values.set(match[1], match[2] ?? '');
  }
  return values;
}

export function readEnv(path: string): Map<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : new Map<string, string>();
}

/** Refuses to write keys to a file that git would track. */
function assertIgnoredByGit(path: string): void {
  try {
    execFileSync('git', ['check-ignore', '-q', basename(path)], {
      cwd: dirname(path),
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`${path} is not ignored by git, so no keys are written to it`);
  }
}

/** 64 bytes, private key then public key, base58: the usual "secret key" string. */
async function newSecretKey(): Promise<string> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const bytes = new Uint8Array(64);
  bytes.set(seed);
  bytes.set(publicKey, 32);
  seed.fill(0);
  const encoded = getBase58Decoder().decode(bytes);
  bytes.fill(0);
  return encoded;
}

/**
 * Generates the keys the file lacks and writes the file (mode 0600). Existing
 * keys and other lines are kept. Returns the roles that got a new key.
 */
export async function ensureKeys(
  paths: { readonly env: string; readonly envExample: string },
  options: { readonly requireGitIgnored?: boolean } = {},
): Promise<Role[]> {
  if (options.requireGitIgnored !== false) assertIgnoredByGit(paths.env);
  const text = existsSync(paths.env)
    ? readFileSync(paths.env, 'utf8')
    : existsSync(paths.envExample)
      ? readFileSync(paths.envExample, 'utf8')
      : '';
  const values = parseEnv(text);
  const missing = ROLES.filter((role) => (values.get(KEY_VARIABLES[role]) ?? '') === '');
  if (missing.length === 0 && existsSync(paths.env)) return [];

  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const role of missing) {
    const variable = KEY_VARIABLES[role];
    const entry = `${variable}=${await newSecretKey()}`;
    const index = lines.findIndex((line) => LINE.exec(line)?.[1] === variable);
    if (index >= 0) lines[index] = entry;
    else lines.push(entry);
  }
  const temp = `${paths.env}.tmp-${String(process.pid)}`;
  writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600 });
  renameSync(temp, paths.env);
  return missing;
}

/** Reads every role's key pair. The private keys are not extractable. */
export async function loadKeyPairs(path: string): Promise<Record<Role, CryptoKeyPair>> {
  const values = readEnv(path);
  const entries = await Promise.all(
    ROLES.map(async (role) => {
      const variable = KEY_VARIABLES[role];
      const secret = values.get(variable) ?? '';
      if (secret === '') throw new Error(`${variable} is empty; run pnpm demo:keys first`);
      let keyPair: CryptoKeyPair;
      try {
        const bytes = new Uint8Array(getBase58Encoder().encode(secret));
        if (bytes.length !== 64) throw new Error('length');
        keyPair = await createKeyPairFromBytes(bytes);
        bytes.fill(0);
      } catch {
        // The cause is dropped on purpose: codec errors quote the input.
        throw new Error(`${variable} is not a valid 64-byte secret key`);
      }
      return [role, keyPair] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Role, CryptoKeyPair>;
}

/**
 * The RPC URL from the key file, or the public devnet endpoint. A URL that
 * names mainnet is refused before any request is made. The URL is never
 * printed, because a provider URL can carry an API key.
 */
export function rpcUrlFrom(path: string): string {
  const url = readEnv(path).get('SOLANA_RPC_URL') ?? '';
  const chosen = url === '' ? DEVNET_RPC_URL : url;
  if (/mainnet/i.test(chosen)) {
    throw new Error('SOLANA_RPC_URL names mainnet; the demo runs on devnet only');
  }
  return chosen;
}
