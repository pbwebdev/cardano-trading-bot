export const toDec = (n: bigint, decimals: number) => Number(n) / 10 ** decimals;
export const toBigint = (nDec: number, decimals: number) => BigInt(Math.floor(nDec * 10 ** decimals));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));