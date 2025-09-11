// --- filepath: src/strategy/emaBand.ts ---
export function nextEma(prev: number | null, price: number, alpha: number): number {
    if (prev == null || Number.isNaN(prev)) return price;
    return alpha * price + (1 - alpha) * prev;
}

export function bandFromCenter(center: number, bandBps: number) {
    const width = center * (bandBps / 10000);
    return { lo: center - width, hi: center + width };
}

export function shouldTrade(mid: number, center: number, edgeBps: number) {
    const edge = center * (edgeBps / 10000);
    const buy  = mid < center - edge;   // buy TOKEN_B with A
    const sell = mid > center + edge;   // sell TOKEN_B for A
    return { buy, sell };
}