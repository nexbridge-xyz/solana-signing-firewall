// Program addresses come from the official program clients. Never type them by hand.
export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
export { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
export { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
export { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
export { ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS } from '@solana-program/address-lookup-table';

// The SPL Memo program (MemoSq4g...). This is the program the x402 `exact` scheme for
// Solana names, and the one wallets use. `@solana-program/memo` 0.16 exports it as
// LEGACY_MEMO_PROGRAM_ADDRESS_V3 because its MEMO_PROGRAM_ADDRESS now points to a newer,
// upgradeable program. Only this one counts as "Memo" in v0.1.0 (docs/DECISIONS.md).
export { LEGACY_MEMO_PROGRAM_ADDRESS_V3 as SPL_MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
