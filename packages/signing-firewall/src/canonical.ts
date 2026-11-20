import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON values this library hashes:
 * object keys sorted by UTF-16 code units, no whitespace, strings and numbers
 * serialized as ECMAScript's JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON: unsupported ${typeof value}`);
}

/** SHA-256, hex. Synchronous, so quote checks can run inside the x402 client's synchronous policy hook. */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}
