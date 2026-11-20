import { snapshotToJson } from '@nexbridge/solana-signing-firewall';

import { stableJson } from '../format.js';
import { SLOT } from '../vectors.js';
import type { X402Vector } from './format.js';
import { X402_SPEC_LABELS } from './labels.js';
import { X402_NOW, X402_VECTORS } from './vectors.js';
import { agentPolicy, createX402World, facilitatorConfig } from './world.js';

export const AGENT_POLICY_FILE = 'policies/fixtures-agent.json';
export const VERIFIER_CONFIG_FILE = 'verifier/fixtures-facilitator.json';

export async function buildX402Files(): Promise<Map<string, string>> {
  const ids = X402_VECTORS.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate x402 vector id');
  for (const id of Object.keys(X402_SPEC_LABELS)) {
    if (!ids.includes(id)) throw new Error(`a spec label for ${id}, which is not a vector`);
  }
  const w = await createX402World();
  const files = new Map<string, string>([
    [AGENT_POLICY_FILE, stableJson(agentPolicy(w))],
    [VERIFIER_CONFIG_FILE, stableJson(facilitatorConfig(w))],
  ]);
  for (const definition of X402_VECTORS) {
    const built = await definition.build(w);
    const label = X402_SPEC_LABELS[definition.id];
    if (label === undefined) throw new Error(`no spec label for ${definition.id}`);
    const vector: X402Vector = {
      id: definition.id,
      title: definition.title,
      specRules: [...label.specRules],
      specVerdict: label.specVerdict,
      ...(label.notes === undefined ? {} : { notes: label.notes }),
      requirements: built.requirements,
      ...(built.transaction === undefined ? {} : { transaction: built.transaction }),
      ...(built.client === undefined ? {} : { policy: AGENT_POLICY_FILE }),
      ...(built.facilitator === undefined ? {} : { verifierConfig: VERIFIER_CONFIG_FILE }),
      snapshot: snapshotToJson({ slot: SLOT, accounts: new Map(built.accounts) }),
      ...(built.ledger === undefined ? {} : { ledger: built.ledger }),
      now: X402_NOW,
      expect: {
        ...(built.client === undefined ? {} : { client: built.client }),
        ...(built.facilitator === undefined ? {} : { facilitator: built.facilitator }),
      },
    };
    files.set(`${definition.id}.json`, stableJson(vector));
  }
  return files;
}
