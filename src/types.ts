// --- filepath: src/types.ts ---
export type Net = "Mainnet" | "Preprod" | "Preview";
export type Unit = string; // policy+asset hex or "lovelace"

export interface TokenPair {
    a: Unit; // TOKEN_A (base)
    b: Unit; // TOKEN_B (quote)
}

export interface BandState {
    center: number; // mid EMA center in (B per A)
    updatedAt: number;
}

export interface FillLogRow {
    ts: string;
    side: "BUY_B" | "SELL_B"; // buy TOKEN_B with A or sell B for A
    price: number; // B per A executed
    inAmountDec: number;
    outAmountDec: number;
    pnlDec?: number;
    center?: number;
    bandLo?: number;
    bandHi?: number;
    stop?: string; // if trailing stop triggered
    configId?: string; // hash of key params for audit
}

export interface TokenInfo {
    token_id: Unit;
    ticker?: string;
    project_name?: string;
    decimals?: number;
    is_verified?: boolean;
    logo?: string;
    price_by_ada?: number;
}

export interface WalletBalances {
    adaDec: number;
    tokens: Record<Unit, { amountDec: number; info?: TokenInfo }>;
}
