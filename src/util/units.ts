// --- filepath: src/util/units.ts ---
/**
 * Decimal utilities for safe amount handling.
 * Floors (never rounds up) to a fixed number of decimal places and
 * converts to base units as bigint.
 */
export function floorToDp(amountHuman: number | string, dp: number): string {
  const s = (typeof amountHuman === "string" ? amountHuman : String(amountHuman)).trim();
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [iRaw, fRaw = ""] = abs.split(".");
  const i = (iRaw.replace(/^0+(?=\d)/, "")) || "0";
  if (dp <= 0) return (neg ? "-" : "") + i;
  const flooredFrac = fRaw.slice(0, dp).padEnd(dp, "0");
  return (neg ? "-" : "") + i + "." + flooredFrac;
}

export function toUnitsFloor(amountHuman: number | string, dp: number): bigint {
  const s = floorToDp(amountHuman, dp);
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [i = "0", f = ""] = abs.split(".");
  const frac = f.padEnd(dp, "0");
  const digits = (i + frac).replace(/^0+/, "") || "0";
  const n = BigInt(digits);
  return neg ? -n : n;
}

export function isZeroOrNegative(amountHuman: number | string, dp: number): boolean {
  return toUnitsFloor(amountHuman, dp) <= 0n;
}
