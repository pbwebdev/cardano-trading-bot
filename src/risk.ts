import type { AppConfig } from "./config.js";


export interface Balance {
    ada: number;
    a: number;
    b: number;
// values are in human units (not lovelace / smallest units)
}


export function capSizes(cfg: AppConfig, side: "BUY_B" | "SELL_B", bal: Balance) {
    const maxPct = side === "BUY_B" ? cfg.MAX_PCT_A : cfg.MAX_PCT_B;
    return { maxNotionalPct: maxPct };
}


export function passesMinTrade(cfg: AppConfig, side: "BUY_B" | "SELL_B", amountDec: number) {
    const min = side === "BUY_B" ? cfg.MIN_TRADE_A_DEC : cfg.MIN_TRADE_B_DEC;
    return amountDec >= min;
}


export function sizeWithCaps(
    cfg: AppConfig,
    side: "BUY_B" | "SELL_B",
    bal: Balance,
    wantAmountDec: number
): number {
    if (side === "BUY_B") {
        const cap = (cfg.MAX_PCT_A / 100) * bal.a;
        const availA = cap;
        const reserve = 0; // reserve applied at caller if A=ADA
        return Math.max(0, Math.min(wantAmountDec, availA - reserve));
    } else {
        const cap = (cfg.MAX_PCT_B / 100) * bal.b;
        return Math.max(0, Math.min(wantAmountDec, cap));
    }
}


export function applyAdaReserve(amountA: number, adaBalance: number, reserveAda: number): number {
    if (reserveAda <= 0) return amountA;
    const maxSpend = Math.max(0, adaBalance - reserveAda);
    return Math.min(amountA, maxSpend);
}