import { fileURLToPath } from 'node:url';

export const CORE_DIR = fileURLToPath(new URL('../vectors/core/', import.meta.url));
export const X402_DIR = fileURLToPath(new URL('../vectors/x402/', import.meta.url));
