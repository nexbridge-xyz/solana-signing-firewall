import { describe, expect, it } from 'vitest';
import { getDefaultAsset } from '@x402/svm';

import { DEVNET_USDC_MINT } from '@nexbridge/example-demo-common';
import { createX402World } from '@nexbridge/solana-signing-firewall-fixtures/x402';

import { DEVNET, HOST, hostileOptions } from '../src/index.js';

describe('demo constants', () => {
  it("uses the x402 SDK's devnet USDC, which the vectors use too", async () => {
    expect(getDefaultAsset(DEVNET, 'USDC').asset).toBe(DEVNET_USDC_MINT);
    expect((await createX402World()).mint).toBe(DEVNET_USDC_MINT);
  });

  it('listens on 127.0.0.1 only', () => {
    expect(HOST).toBe('127.0.0.1');
  });

  it("takes scene 13's unlisted token from the SDK's devnet defaults", () => {
    const options = hostileOptions({
      shop: DEVNET_USDC_MINT,
      outsider: DEVNET_USDC_MINT,
      agent: DEVNET_USDC_MINT,
      feePayer: DEVNET_USDC_MINT,
      usdc: DEVNET_USDC_MINT,
    });
    expect(options.map((o) => o.amount)).toEqual(['10000', '10000', '10000', '2000000']);
    expect(options[2]?.asset).toBe(getDefaultAsset(DEVNET, 'PYUSD').asset);
  });
});
