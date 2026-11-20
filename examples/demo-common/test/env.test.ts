import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEVNET_RPC_URL,
  KEY_VARIABLES,
  ensureKeys,
  loadKeyPairs,
  readEnv,
  rpcUrlFrom,
} from '../src/index.js';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-env-'));
  return { env: join(dir, '.env'), envExample: join(dir, '.env.example') };
};

describe('demo keys', () => {
  it('generates every missing key once, keeps other lines and writes the file 0600', async () => {
    const paths = fresh();
    writeFileSync(paths.envExample, '# comment\nTREASURY_SECRET_KEY=\nSOLANA_RPC_URL=\n');
    expect(await ensureKeys(paths, { requireGitIgnored: false })).toHaveLength(8);
    const text = readFileSync(paths.env, 'utf8');
    expect(text.startsWith('# comment\n')).toBe(true);
    expect(text).toContain('SOLANA_RPC_URL=\n');
    expect(statSync(paths.env).mode & 0o777).toBe(0o600);
    expect(await ensureKeys(paths, { requireGitIgnored: false })).toEqual([]);
    expect(readFileSync(paths.env, 'utf8')).toBe(text);
    const keys = await loadKeyPairs(paths.env);
    expect(Object.keys(keys)).toHaveLength(8);
  });

  it('refuses to write keys to a file git does not ignore', async () => {
    await expect(ensureKeys(fresh())).rejects.toThrow(/not ignored by git/);
  });

  it('reports a bad key without quoting it', async () => {
    const paths = fresh();
    await ensureKeys(paths, { requireGitIgnored: false });
    const bad = 'not-base58-0OIl-secret-value';
    const text = readFileSync(paths.env, 'utf8').replace(
      new RegExp(`${KEY_VARIABLES.agent}=.*`),
      `${KEY_VARIABLES.agent}=${bad}`,
    );
    writeFileSync(paths.env, text);
    const error: unknown = await loadKeyPairs(paths.env).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const { message, cause } = error as Error;
    expect(message).toBe('AGENT_SECRET_KEY is not a valid 64-byte secret key');
    expect(cause).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(bad);
  });

  it('uses the public devnet endpoint by default and refuses a mainnet URL', () => {
    const paths = fresh();
    writeFileSync(paths.env, 'SOLANA_RPC_URL=\n');
    expect(rpcUrlFrom(paths.env)).toBe(DEVNET_RPC_URL);
    writeFileSync(paths.env, 'SOLANA_RPC_URL=https://api.mainnet-beta.solana.com\n');
    expect(() => rpcUrlFrom(paths.env)).toThrow(/devnet only/);
    expect(readEnv(paths.env).get('SOLANA_RPC_URL')).toContain('mainnet');
  });
});
