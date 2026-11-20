// Security review: what a person reads in a policy file is what the code enforces, and the
// policy digest names what is enforced.
//
// Two gaps at the reviewed commit:
//   - JSON.parse() keeps the last of two equal keys and says nothing. A policy file can show
//     one recipient list near the top and carry another further down; parsePolicy() gets the
//     parsed object and cannot tell. There was no way to load a policy from its text.
//   - parsePolicy() kept the caller's object and policyDigest() hashed it again on every call.
//     Changing that object afterwards changed the digest, but not the rules already parsed
//     from it, so an approval could name a digest of rules that are not the ones enforced.
import { describe, expect, it } from 'vitest';

import * as library from '../src/index.js';
import { PolicyError, canonicalDigest, parsePolicy, policyDigest } from '../src/index.js';
import { policyJson, testWorld } from './world.js';

const w = await testWorld();
const outsider = w.outsider.address;

/** parsePolicyText() does not exist before the fix: then every use of it fails. */
const parsePolicyText = (text: string) =>
  (library as unknown as { parsePolicyText: (text: string) => library.Policy }).parsePolicyText(
    text,
  );

describe('a policy file with a key written twice', () => {
  it('is refused when the second "recipients" replaces the one a reader sees first', () => {
    const shown = JSON.stringify(policyJson(w), null, 2);
    // Appended as the last member: valid JSON, and JSON.parse() takes this one.
    const hidden = `,\n  "recipients": { "owners": ["${outsider}"] }\n}`;
    const text = shown.replace(/\n}$/, hidden);
    expect((JSON.parse(text) as { recipients: { owners: string[] } }).recipients.owners).toEqual([
      outsider,
    ]);
    expect(() => parsePolicyText(text)).toThrow(PolicyError);
    expect(() => parsePolicyText(text)).toThrow(/policy\.recipients.*twice/);
  });

  it('is refused for a nested key, and for a key repeated in escaped form', () => {
    const mint = w.mint;
    const base = policyJson(w);
    const nested = JSON.stringify(base).replace(
      `"maxPerTransaction":"5000000"`,
      `"maxPerTransaction":"5000000","maxPerTransaction":"18446744073709551615"`,
    );
    expect(() => parsePolicyText(nested)).toThrow(
      new RegExp(`policy\\.mints\\.${mint}\\.maxPerTransaction`),
    );
    const escaped = JSON.stringify(base).replace(
      `"signer":"${w.treasury.address}"`,
      `"signer":"${w.treasury.address}","sign\\u0065r":"${outsider}"`,
    );
    expect(() => parsePolicyText(escaped)).toThrow(/policy\.signer.*twice/);
  });

  it('accepts a file without repeated keys, with the same result as parsePolicy()', () => {
    const json = policyJson(w, { x402: undefined });
    const text = JSON.stringify(json, null, 2);
    const fromText = parsePolicyText(text);
    expect(policyDigest(fromText)).toBe(policyDigest(parsePolicy(json)));
    expect(fromText.recipients.owners).toEqual([w.vendor.address]);
    // The same key in two different objects is not a repeat.
    expect(() =>
      parsePolicyText(JSON.stringify({ ...json, memo: { allowed: true, maxBytes: 64 } })),
    ).not.toThrow();
  });

  it('refuses text that is not JSON with a PolicyError', () => {
    expect(() => parsePolicyText('{ "schema": ')).toThrow(PolicyError);
    expect(() => parsePolicyText('')).toThrow(PolicyError);
  });
});

describe('a policy object that is not plain JSON', () => {
  it('is refused with a PolicyError, not with a serializer error', () => {
    const withBigInt = { ...policyJson(w), fees: { maxComputeUnitLimit: 200000n } };
    expect(() => parsePolicy(withBigInt)).toThrow(PolicyError);
    const cyclic: Record<string, unknown> = { ...policyJson(w) };
    cyclic.self = cyclic;
    expect(() => parsePolicy(cyclic)).toThrow(PolicyError);
  });
});

describe('the policy digest', () => {
  it("names the rules that were parsed, whatever happens to the caller's object afterwards", () => {
    const json = policyJson(w);
    const digestBefore = canonicalDigest(json);
    const policy = parsePolicy(json);
    expect(policyDigest(policy)).toBe(digestBefore);

    // The caller's object changes after parsing: a new recipient, a higher cap.
    (json.recipients as { owners: string[] }).owners.push(outsider);
    const rule = (json.mints as Record<string, { maxPerTransaction: string }>)[w.mint];
    if (rule !== undefined) rule.maxPerTransaction = '18446744073709551615';

    // The enforced rules did not change, so the digest must not change either.
    expect(policy.recipients.owners).toEqual([w.vendor.address]);
    expect(policy.mints.get(w.mint)?.maxPerTransaction).toBe(5_000_000n);
    expect(policyDigest(policy)).toBe(digestBefore);
  });
});
