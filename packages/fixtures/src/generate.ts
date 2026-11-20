// Writes vectors/core/ deterministically. With --check, regenerates in memory
// and fails on any difference from the committed files (used by CI).
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { getBase64Decoder } from '@solana/kit';

import { snapshotToJson } from '@nexbridge/solana-signing-firewall';

import { type CoreVector, stableJson } from './format.js';
import { CORE_DIR, X402_DIR } from './paths.js';
import { CORE_VECTORS, NOW, SLOT } from './vectors.js';
import { POLICY_FILES, type PolicyName, createWorld, policyJson } from './world.js';
import { buildX402Files } from './x402/generate.js';

export async function buildCoreFiles(): Promise<Map<string, string>> {
  const ids = CORE_VECTORS.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate vector id');

  const world = await createWorld();
  const files = new Map<string, string>();
  for (const [name, file] of Object.entries(POLICY_FILES) as [PolicyName, string][]) {
    files.set(file, stableJson(policyJson(world, name)));
  }
  for (const definition of CORE_VECTORS) {
    const built = await definition.build(world);
    const vector: CoreVector = {
      id: definition.id,
      title: definition.title,
      category: definition.category,
      messageVersion: built.messageVersion,
      runtimeVerdict: built.runtimeVerdict,
      runtimeCheckedBy: built.runtimeCheckedBy,
      ...(built.notes === undefined ? {} : { notes: built.notes }),
      message: getBase64Decoder().decode(built.message),
      policy: POLICY_FILES[built.policy],
      snapshot: snapshotToJson({ slot: SLOT, accounts: new Map(built.accounts) }),
      now: NOW,
      ...(built.approval === undefined ? {} : { approval: built.approval }),
      expect: {
        outcome: built.outcome,
        reasons: built.reasons,
        ...(built.approvalReasons === undefined
          ? {}
          : { approval: { reasons: built.approvalReasons } }),
        ...(built.decoded === undefined ? {} : { decoded: built.decoded }),
      },
    };
    files.set(`${definition.id}.json`, stableJson(vector));
  }
  return files;
}

async function listJson(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

async function sync(dir: string, files: Map<string, string>, check: boolean): Promise<string[]> {
  const onDisk = await listJson(dir);
  const problems: string[] = [];
  if (check) {
    for (const [name, content] of files) {
      const current = await readFile(join(dir, name), 'utf8').catch(() => undefined);
      if (current === undefined) problems.push(`missing: ${name}`);
      else if (current !== content) problems.push(`differs: ${name}`);
    }
    for (const name of onDisk) if (!files.has(name)) problems.push(`not generated: ${name}`);
    return problems;
  }
  for (const [name, content] of files) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  for (const name of onDisk) if (!files.has(name)) await rm(join(dir, name));
  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const sets: [string, string, Map<string, string>][] = [
    ['vectors/core', CORE_DIR, await buildCoreFiles()],
    ['vectors/x402', X402_DIR, await buildX402Files()],
  ];
  const problems: string[] = [];
  for (const [label, dir, files] of sets) {
    problems.push(...(await sync(dir, files, check)).map((p) => `${label}: ${p}`));
  }
  if (problems.length > 0) {
    console.error(
      `Vectors are out of date (run pnpm fixtures:generate):\n  ${problems.join('\n  ')}`,
    );
    process.exit(1);
  }
  const count = sets.reduce((n, [, , files]) => n + files.size, 0);
  console.log(
    check ? `${count} vector files match the generator.` : `Wrote ${count} vector files.`,
  );
}

await main();
