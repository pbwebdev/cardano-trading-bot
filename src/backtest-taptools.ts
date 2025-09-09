// src/backtest-taptools.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Backtests the EMA-band strategy to match src/bot-twoway.ts behavior.
 * Adds decision cadence + cycle profit filter + trailing/hard stops.
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// Strategy envs (match bot)
const BAND_BPS   = num(process.env.BAND_BPS, 50);
const BAND_ALPHA = num(process.env.BAND_ALPHA, 0.10);
const EDGE_BPS   = num(process.env.EDGE_BPS, 5);
const MIN_NOTIONAL_OUT = num(process.env.MIN_NOTIONAL_OUT, 0); // guard on min_out (human)
const ONLY_VERIFIED = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// Sizing caps (human units; act as ceilings)
const AMOUNT_A_DEC_CAP = num(process.env.AMOUNT_A_DEC, 10);
const AMOUNT_B_DEC_CAP = num(process.env.AMOUNT_B_DEC, 100);

// Dynamic sizing controls (mirror bot defaults)
const MAX_PCT_A = num(process.env.MAX_PCT_A, 15);
const MAX_PCT_B = num(process.env.MAX_PCT_B, 15);
const MIN_TRADE_A_DEC = num(process.env.MIN_TRADE_A_DEC, 5);
const MIN_TRADE_B_DEC = num(process.env.MIN_TRADE_B_DEC, 50);
const RESERVE_ADA_DEC = num(process.env.RESERVE_ADA_DEC, 0);
const FEE_BUF_ADA     = 2; // small fee headroom

// Pair
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim();
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim();

// TapTools request
const TAP_BASE     = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY      = process.env.TAPTOOLS_API_KEY!;
const INTERVAL     = (process.env.BT_INTERVAL ?? "1h").trim();
const MAX_CANDLES  = num(process.env.BT_MAX_POINTS, 3000);
const START_EPOCH  = num(process.env.BT_START_EPOCH, 0); // ms epoch (optional)
const END_EPOCH    = num(process.env.BT_END_EPOCH, 0);   // ms epoch (optional)
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "true").toLowerCase() === "true";

// Fees (bps)
const POOL_FEE_BPS      = num(process.env.BT_POOL_FEE_BPS, 30);
const EXTRA_AGG_FEE_BPS = num(process.env.BT_AGG_FEE_BPS, 0);

// Optional backtest cooldown (ms) – to reflect live behavior
const BT_COOLDOWN_MS    = num(process.env.BT_COOLDOWN_MS, 0);

// Decision cadence (0 disables; e.g., 14_400_000 = 4h)
const BT_DECISION_EVERY_MS = num(process.env.BT_DECISION_EVERY_MS, 0);

// Profit filter & stops (0 = disabled)
const USE_CYCLE_FILTER   = (process.env.USE_CYCLE_FILTER ?? "true").toLowerCase() === "true";
const MIN_CYCLE_PNL_BPS  = num(process.env.MIN_CYCLE_PNL_BPS, 0);
const EST_CYCLE_FEES_BPS = num(process.env.EST_CYCLE_FEES_BPS, 60);
const TRAIL_STOP_BPS     = num(process.env.TRAIL_STOP_BPS, 0);
const HARD_STOP_BPS      = num(process.env.HARD_STOP_BPS, 0);

// Output
const OUT = path.join(process.cwd(), "backtest_trades.csv");
ensureCsvHeader(
    OUT,
    "ts,side,mid,center,lower,upper,amount_in,token_in,amount_out,token_out,fee_bps,pnl_ada,rolling_ada\n"
);

// Same AGG as bot to resolve tokens by ticker
const AGG = "https://agg-api.minswap.org/aggregator";

/* ---------- helpers ---------- */
function num(x: any, def: number): number {
    const n = Number(x);
    return Number.isFinite(n) ? n : def;
}
function isUnit(u: string) {
    return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(u);
}
function bpsOver(x: number, y: number) { return ((x - y) / y) * 10000; }
function bounds(center: number, bps: number) {
    return { lower: center * (1 - bps / 10000), upper: center * (1 + bps / 10000) };
}
function applyFeesOut(amountOut: number, totalFeeBps: number) {
    return amountOut * (1 - totalFeeBps / 10000);
}
function ensureCsvHeader(file: string, header: string) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, header, "utf8");
}
function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}

/** Resolve a token to on-chain unit using Minswap Aggregator (like the live bot). */
async function resolveTokenId(query: string): Promise<string> {
    if (query.toUpperCase() === "ADA") return "lovelace";
    if (isUnit(query)) return query;

    const resp = await axios.post(`${AGG}/tokens`, { query, only_verified: ONLY_VERIFIED });
    const items: any[] = resp.data?.tokens ?? [];
    if (!items.length) throw new Error(`Token not found: ${query}`);
    const exact = items.find((t: any) => (t.ticker || "").toLowerCase() === query.toLowerCase());
    const chosen = exact ?? items[0];
    console.log(`Resolved ${query} => ${chosen.token_id || "lovelace"} (${chosen.ticker ?? ""})`);
    return chosen.token_id;
}

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume?: number };

/** Fetch candles from TapTools. */
async function fetchCandlesTapTools(params: {
    unitBase: string;  // TOKEN_B unit (asset whose price we want)
    vsUnit: string;    // quote denominator (ADA=lovelace) for B/A series
    interval: string;
    limit: number;
    start?: number; // ms epoch
    end?: number;   // ms epoch
}): Promise<Candle[]> {
    const PATH = "/api/v1/token/ohlcv";
    const q: Record<string, any> = {
        unit: params.unitBase,
        onchainID: params.unitBase,
        vs_unit: params.vsUnit,
        interval: params.interval,
        limit: params.limit,
    };
    if (params.start && params.start > 0) q.start = Math.floor(params.start / 1000);
    if (params.end && params.end > 0)     q.end   = Math.floor(params.end / 1000);

    const url = `${TAP_BASE}${PATH}`;
    try {
        const resp = await axios.get(url, {
            headers: { "x-api-key": TAP_KEY, accept: "application/json" },
            params: q,
        });
        const raw = resp.data?.data ?? resp.data;
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error("No candle data returned from TapTools (check unit/interval/time window).");
        }
        const candles: Candle[] = raw.map((k: any) => ({
            ts: normalizeTs(k.ts ?? k.time ?? k.timestamp),
            open: Number(k.open ?? k.o),
            high: Number(k.high ?? k.h),
            low:  Number(k.low  ?? k.l),
            close:Number(k.close?? k.c),
            volume: k.volume ?? k.v,
        })).filter((c: Candle) => Number.isFinite(c.close));
        return candles;
    } catch (e: any) {
        console.error("TapTools request failed", {
            url, params: q, status: e?.response?.status, data: e?.response?.data,
        });
        throw e;
    }
}
function normalizeTs(x: number) {
    if (!Number.isFinite(x)) return Date.now();
    return String(x).length < 13 ? x * 1000 : x;
}

/* ---------- dynamic sizing (backtest) ---------- */
function computeDynamicSizesFromInventory(
    invA: number, invB: number, mid: number,
    caps: { capA: number; capB: number },
    aIsAda: boolean
): { sizeA: number; sizeB: number } {

    let maxSpendA = invA;
    if (aIsAda) {
        maxSpendA = Math.max(0, invA - RESERVE_ADA_DEC - FEE_BUF_ADA);
    }

    const dynA = (MAX_PCT_A / 100) * maxSpendA;
    const dynB = (MAX_PCT_B / 100) * invB;

    const sizeA = Math.min(
        invA,
        clamp(dynA, MIN_TRADE_A_DEC, caps.capA)
    );

    const sizeB = Math.min(
        invB,
        clamp(dynB, MIN_TRADE_B_DEC, caps.capB)
    );

    return { sizeA, sizeB };
}

async function main() {
    if (!TAP_KEY) throw new Error("Missing TAPTOOLS_API_KEY");

    // Resolve units to align with bot
    const unitA = TOKEN_A_Q.toUpperCase() === "ADA" ? "lovelace" : await resolveTokenId(TOKEN_A_Q);
    const unitB = await resolveTokenId(TOKEN_B_Q);

    const vsUnit = unitA === "lovelace" ? "lovelace" : unitA;

    const candles = await fetchCandlesTapTools({
        unitBase: unitB,
        vsUnit,
        interval: INTERVAL,
        limit: MAX_CANDLES,
        start: START_EPOCH || undefined,
        end: END_EPOCH || undefined,
    });

    if (!candles.length) throw new Error("No candles returned.");

    // Build series from closes and enforce mid definition
    const series = candles
        .map(c => ({ t: c.ts, mid: Number(c.close) }))
        .filter(p => Number.isFinite(p.mid))
        .sort((a, b) => a.t - b.t);

    if (!PRICE_IS_B_PER_A) {
        for (const p of series) p.mid = 1 / p.mid;
    }

    console.log(
        `Backtest pair: A=${TOKEN_A_Q} (${unitA})  B=${TOKEN_B_Q} -> ${unitB}\n` +
        `Points=${series.length}  | interval=${INTERVAL} | BAND_BPS=${BAND_BPS} ALPHA=${BAND_ALPHA} EDGE_BPS=${EDGE_BPS}\n` +
        `Caps: A<=${AMOUNT_A_DEC_CAP}  B<=${AMOUNT_B_DEC_CAP}  | Fees: pool=${POOL_FEE_BPS}bps agg=${EXTRA_AGG_FEE_BPS}bps\n` +
        `Sizing: MAX_PCT_A=${MAX_PCT_A}% MAX_PCT_B=${MAX_PCT_B}% | Floors: A=${MIN_TRADE_A_DEC} B=${MIN_TRADE_B_DEC} | ADA reserve=${RESERVE_ADA_DEC}`
    );

    // Sim state (start balances)
    let invA = num(process.env.BT_START_ADA, 100);
    let invB = num(process.env.BT_START_TOKB, 0);
    const totalFeeBps = POOL_FEE_BPS + EXTRA_AGG_FEE_BPS;

    // EMA center & cooldown/cadence
    let center = series[0].mid;
    let lastTradeAt = 0;

    // Decision cadence alignment
    let nextDecisionAt = 0;
    function alignNextDecision(ts: number) {
        if (BT_DECISION_EVERY_MS <= 0) return;
        const bucket = Math.floor(ts / BT_DECISION_EVERY_MS) + 1;
        nextDecisionAt = bucket * BT_DECISION_EVERY_MS;
    }
    if (BT_DECISION_EVERY_MS > 0) alignNextDecision(series[0].t);

    // Position memory
    type PosMode = "LONG_A" | "LONG_B" | null;
    let posMode: PosMode = null;
    let entryMid = 0;
    let peakMid = 0;
    let troughMid = 0;

    function favorableMoveBps(midNow: number) {
        if (posMode === "LONG_B") return ((midNow - entryMid) / entryMid) * 10000;
        if (posMode === "LONG_A") return ((entryMid - midNow) / entryMid) * 10000;
        return 0;
    }
    function trailDrawdownBps(midNow: number) {
        if (posMode === "LONG_B" && peakMid > 0) return ((peakMid - midNow) / peakMid) * 10000;
        if (posMode === "LONG_A" && troughMid > 0) return ((midNow - troughMid) / troughMid) * 10000;
        return 0;
    }
    function hardStopFromEntryBps(midNow: number) {
        if (posMode === "LONG_B") return ((entryMid - midNow) / entryMid) * 10000;
        if (posMode === "LONG_A") return ((midNow - entryMid) / entryMid) * 10000;
        return 0;
    }
    function openPos(newMode: PosMode, midNow: number) {
        posMode = newMode; entryMid = peakMid = troughMid = midNow;
    }
    function closePos() {
        posMode = null; entryMid = peakMid = troughMid = 0;
    }

    let rollingMarkedAda = invA + (invB / series[0].mid);

    for (const { t, mid } of series) {
        // EMA update
        center = BAND_ALPHA * mid + (1 - BAND_ALPHA) * center;
        const { lower, upper } = bounds(center, BAND_BPS);

        // Update extremes
        if (posMode) {
            peakMid   = Math.max(peakMid || mid, mid);
            troughMid = Math.min(troughMid || mid, mid);
        }

        // decision like bot
        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= EDGE_BPS) action = "SELL_A";
        else if (mid < lower && underLower >= EDGE_BPS) action = "SELL_B";

        // cadence gate
        if (BT_DECISION_EVERY_MS > 0 && t < nextDecisionAt) {
            rollingMarkedAda = invA + (invB / mid);
            continue;
        }

        // forced close via trailing/hard stop
        let forcedClose: "SELL_A" | "SELL_B" | null = null;
        if (posMode) {
            const tdBps = TRAIL_STOP_BPS > 0 ? trailDrawdownBps(mid) : -1;
            const hsBps = HARD_STOP_BPS  > 0 ? hardStopFromEntryBps(mid) : -1;
            if ((TRAIL_STOP_BPS > 0 && tdBps >= TRAIL_STOP_BPS) || (HARD_STOP_BPS > 0 && hsBps >= HARD_STOP_BPS)) {
                forcedClose = posMode === "LONG_B" ? "SELL_B" : "SELL_A";
            }
        }

        let planned: "HOLD" | "SELL_A" | "SELL_B" = forcedClose ?? action;

        // cooldown
        if (planned !== "HOLD" && BT_COOLDOWN_MS > 0) {
            const remain = BT_COOLDOWN_MS - (t - lastTradeAt);
            if (remain > 0) planned = "HOLD";
        }

        // disallow add-to-same-side
        if (posMode === "LONG_B" && planned === "SELL_A") planned = "HOLD";
        if (posMode === "LONG_A" && planned === "SELL_B") planned = "HOLD";

        // profit filter when closing a cycle
        if (USE_CYCLE_FILTER && posMode && (
            (posMode==="LONG_B" && planned==="SELL_B") ||
            (posMode==="LONG_A" && planned==="SELL_A")
        )) {
            const need = MIN_CYCLE_PNL_BPS + EST_CYCLE_FEES_BPS;
            if (favorableMoveBps(mid) < need && !forcedClose) planned = "HOLD";
        }

        // If no trade, just mark portfolio
        if (planned === "HOLD") {
            rollingMarkedAda = invA + (invB / mid);
            continue;
        }

        // --- Dynamic sizing from balances (mirrors bot) ---
        const { sizeA, sizeB } = computeDynamicSizesFromInventory(
            invA,
            invB,
            mid,
            { capA: AMOUNT_A_DEC_CAP, capB: AMOUNT_B_DEC_CAP },
            /* aIsAda */ TOKEN_A_Q.toUpperCase() === "ADA"
        );

        if (planned === "SELL_A") {
            if (sizeA <= 0 || invA <= 0) { rollingMarkedAda = invA + (invB / mid); continue; }

            const rawOutB = mid * sizeA;
            if (MIN_NOTIONAL_OUT > 0 && rawOutB < MIN_NOTIONAL_OUT) {
                rollingMarkedAda = invA + (invB / mid);
                continue;
            }

            const outB = applyFeesOut(rawOutB, POOL_FEE_BPS + EXTRA_AGG_FEE_BPS);
            const pnlAda = (outB / mid) - sizeA;

            invA -= sizeA;
            invB += outB;
            lastTradeAt = t;

            if (BT_DECISION_EVERY_MS > 0) alignNextDecision(t);

            // Position updates
            if (posMode === "LONG_A") closePos();
            if (posMode === null) openPos("LONG_B", mid);

            rollingMarkedAda = invA + (invB / mid);

            appendCsv(OUT, [
                new Date(t).toISOString(),
                "SELL_A",
                mid,
                center,
                lower,
                upper,
                sizeA,
                TOKEN_A_Q,
                outB,
                TOKEN_B_Q,
                POOL_FEE_BPS + EXTRA_AGG_FEE_BPS,
                pnlAda,
                rollingMarkedAda
            ]);
        } else {
            // SELL_B
            if (sizeB <= 0 || invB <= 0) { rollingMarkedAda = invA + (invB / mid); continue; }

            const rawOutA = sizeB / mid;
            if (MIN_NOTIONAL_OUT > 0 && rawOutA < MIN_NOTIONAL_OUT) {
                rollingMarkedAda = invA + (invB / mid);
                continue;
            }

            const outA = applyFeesOut(rawOutA, POOL_FEE_BPS + EXTRA_AGG_FEE_BPS);
            const pnlAda = outA - (sizeB / mid);

            invB -= sizeB;
            invA += outA;
            lastTradeAt = t;

            if (BT_DECISION_EVERY_MS > 0) alignNextDecision(t);

            // Position updates
            if (posMode === "LONG_B") closePos();
            if (posMode === null) openPos("LONG_A", mid);

            rollingMarkedAda = invA + (invB / mid);

            appendCsv(OUT, [
                new Date(t).toISOString(),
                "SELL_B",
                mid,
                center,
                lower,
                upper,
                sizeB,
                TOKEN_B_Q,
                outA,
                TOKEN_A_Q,
                POOL_FEE_BPS + EXTRA_AGG_FEE_BPS,
                pnlAda,
                rollingMarkedAda
            ]);
        }
    }

    const lastMid = series[series.length - 1].mid;
    const endMarkedAda = invA + (invB / lastMid);

    console.log(`Candles: ${series.length}`);
    console.log(`End Balances → ${TOKEN_A_Q}=${invA.toFixed(6)} ; ${TOKEN_B_Q}=${invB.toFixed(6)} ; Marked ADA=${endMarkedAda.toFixed(6)} (mid=${lastMid.toFixed(8)})`);
    console.log(`CSV: ${OUT}`);
}

function appendCsv(file: string, row: any[]) {
    const line = [
        row[0],                                     // ts ISO
        row[1],                                     // side
        fix(row[2], 8),                             // mid
        fix(row[3], 8),                             // center
        fix(row[4], 8),                             // lower
        fix(row[5], 8),                             // upper
        fix(row[6], 6),                             // amount_in
        row[7],                                     // token_in
        fix(row[8], 6),                             // amount_out
        row[9],                                     // token_out
        row[10],                                    // fee_bps
        fix(row[11], 6),                            // pnl_ada
        fix(row[12], 6),                            // rolling_ada
    ].join(",") + "\n";
    fs.appendFileSync(file, line);
}

function fix(x: any, d: number) {
    const n = Number(x);
    if (!Number.isFinite(n)) return String(x);
    return n.toFixed(d);
}

main().catch((err) => {
    console.error(err?.response?.data ?? err);
});
