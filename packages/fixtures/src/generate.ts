// Writes vectors/core/ deterministically. With --check, regenerates in memory
// and fails on any difference from the committed files (used by CI).
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { getBase64Decoder } from '@solana/kit';

import { snapshotToJson } from '@nexbridge/solana-signing-firewall';

import { type CoreVector, stableJson } from './format.js';
import { CORE_DIR } from './paths.js';
import { CORE_VECTORS, NOW, POLICY_FILE, SLOT } from './vectors.js';
import { createWorld, payoutsPolicy } from './world.js';

export async function buildCoreFiles(): Promise<Map<string, string>> {
  const ids = CORE_VECTORS.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate vector id');

  const world = await createWorld();
  const files = new Map<string, string>([[POLICY_FILE, stableJson(payoutsPolicy(world))]]);
  for (const definition of CORE_VECTORS) {
    const built = definition.build(world);
    const vector: CoreVector = {
      id: definition.id,
      title: definition.title,
      category: definition.category,
      messageVersion: built.messageVersion,
      ...(built.notes === undefined ? {} : { notes: built.notes }),
      message: getBase64Decoder().decode(built.message),
      policy: POLICY_FILE,
      snapshot: snapshotToJson({ slot: SLOT, accounts: new Map(built.accounts) }),
      now: NOW,
      expect: {
        outcome: built.outcome,
        reasons: built.reasons,
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

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const files = await buildCoreFiles();
  const onDisk = await listJson(CORE_DIR);

  if (check) {
    const problems: string[] = [];
    for (const [name, content] of files) {
      const current = await readFile(join(CORE_DIR, name), 'utf8').catch(() => undefined);
      if (current === undefined) problems.push(`missing: ${name}`);
      else if (current !== content) problems.push(`differs: ${name}`);
    }
    for (const name of onDisk) if (!files.has(name)) problems.push(`not generated: ${name}`);
    if (problems.length > 0) {
      console.error(
        `Vectors are out of date (run pnpm fixtures:generate):\n  ${problems.join('\n  ')}`,
      );
      process.exit(1);
    }
    console.log(`${files.size} vector files match the generator.`);
    return;
  }

  for (const [name, content] of files) {
    const path = join(CORE_DIR, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  for (const name of onDisk) if (!files.has(name)) await rm(join(CORE_DIR, name));
  console.log(`Wrote ${files.size} files to vectors/core/.`);
}

await main();
