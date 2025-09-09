// src/backtest-sweep.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Grid-sweeps EMA-band strategy with dynamic, balance-aware sizing to mirror src/bot-twoway.ts.
 * Adds decision cadence + cycle profit filter + trailing/hard stops.
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// Pair & data source
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim();
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim();

const TAP_BASE     = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY      = process.env.TAPTOOLS_API_KEY!;
const INTERVAL     = (process.env.BT_INTERVAL ?? "1h").trim();
const MAX_CANDLES  = num(process.env.BT_MAX_POINTS, 3000);
const START_EPOCH  = num(process.env.BT_START_EPOCH, 0); // ms epoch
const END_EPOCH    = num(process.env.BT_END_EPOCH, 0);
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "true").toLowerCase() === "true";

// Fees (bps)
const POOL_FEE_BPS      = num(process.env.BT_POOL_FEE_BPS, 30);
const EXTRA_AGG_FEE_BPS = num(process.env.BT_AGG_FEE_BPS, 0);
const TOTAL_FEE_BPS     = POOL_FEE_BPS + EXTRA_AGG_FEE_BPS;

// Caps (human)
const CAP_A = num(process.env.AMOUNT_A_DEC, 10);
const CAP_B = num(process.env.AMOUNT_B_DEC, 100);

// Start balances (human)
const START_A = num(process.env.BT_START_ADA, 100);
const START_B = num(process.env.BT_START_TOKB, 0);

// Guards & misc
const MIN_NOTIONAL_OUT = num(process.env.MIN_NOTIONAL_OUT, 0);
const RESERVE_ADA_DEC  = num(process.env.RESERVE_ADA_DEC, 0);
const FEE_BUF_ADA      = 2; // small fee headroom
const ONLY_VERIFIED    = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// Sweep ranges (comma/space separated)
const BAND_BPS_LIST    = parseList(process.env.SWEEP_BAND_BPS, [50]);
const EDGE_BPS_LIST    = parseList(process.env.SWEEP_EDGE_BPS, [5]);
const ALPHA_LIST       = parseList(process.env.SWEEP_ALPHA, [0.10]);
const MAX_PCT_A_LIST   = parseList(process.env.SWEEP_MAX_PCT_A, [10, 15, 20]);
const MAX_PCT_B_LIST   = parseList(process.env.SWEEP_MAX_PCT_B, [10, 15, 20]);
const MIN_TR_A_LIST    = parseList(process.env.SWEEP_MIN_TRADE_A, [5]);
const MIN_TR_B_LIST    = parseList(process.env.SWEEP_MIN_TRADE_B, [50]);
const COOLDOWN_LIST    = parseList(process.env.SWEEP_COOLDOWN_MS, [0]); // throttle (ms)

// Decision cadence list (ms) – e.g. "0,14400000"
const DECISION_MS_LIST = parseList(process.env.SWEEP_DECISION_EVERY_MS, [0]);

// NEW: profit filter/stop sweeps
const MIN_CYCLE_BPS_LIST = parseList(process.env.SWEEP_MIN_CYCLE_PNL_BPS, [0]);
const TRAIL_BPS_LIST     = parseList(process.env.SWEEP_TRAIL_STOP_BPS, [0]);
const HARD_BPS_LIST      = parseList(process.env.SWEEP_HARD_STOP_BPS, [0]);
const EST_FEES_BPS       = num(process.env.EST_CYCLE_FEES_BPS, 60); // constant across grid

const OUT = path.join(process.cwd(), "sweep_results.csv");
ensureHeader(
    OUT,
    [
        "ts_run","interval","points",
        "token_a","token_b",
        "band_bps","edge_bps","alpha",
        "max_pct_a","max_pct_b","min_tr_a","min_tr_b",
        "cap_a","cap_b","reserve_ada","pool_fee_bps","agg_fee_bps","cooldown_ms",
        "decision_ms","min_cycle_bps","trail_bps","hard_bps","est_fees_bps",
        "start_a","start_b",
        "end_a","end_b","end_marked_ada","pnl_ada","max_dd_ada",
        "trades","sell_a","sell_b","wins","losses","winrate","avg_pnl_trade"
    ].join(",") + "\n"
);

// Aggregator (for token unit lookup)
const AGG = "https://agg-api.minswap.org/aggregator";

/* ---------- helpers ---------- */
function num(x: any, def: number): number {
    const n = Number(x);
    return Number.isFinite(n) ? n : def;
}
function parseList(s: string | undefined, def: number[]): number[] {
    if (!s) return def;
    const parts = s.split(/[,\s]+/).map(v => v.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    return parts.length ? parts : def;
}
function isUnit(u: string) {
    return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(u);
}
function ensureHeader(file: string, header: string) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, header, "utf8");
}
function appendCsv(file: string, row: (string|number)[]) {
    fs.appendFileSync(file, row.join(",") + "\n");
}
function bpsOver(x: number, y: number) { return ((x - y) / y) * 10000; }
function bounds(center: number, bps: number) {
    return { lower: center * (1 - bps / 10000), upper: center * (1 + bps / 10000) };
}
function applyFeesOut(amountOut: number, totalFeeBps: number) {
    return amountOut * (1 - totalFeeBps / 10000);
}
function fix(x: any, d: number) {
    const n = Number(x);
    if (!Number.isFinite(n)) return String(x);
    return n.toFixed(d);
}

/** Resolve a token unit via Minswap Aggregator (like live bot/backtest). */
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

type Candle = { ts: number; close: number };

async function fetchCandlesTapTools(params: {
    unitBase: string;  // TOKEN_B unit
    vsUnit: string;    // quote denominator (ADA=lovelace) for B/A series
    interval: string;
    limit: number;
    start?: number;
    end?: number;
}): Promise<Candle[]> {
    if (!TAP_KEY) throw new Error("Missing TAPTOOLS_API_KEY");
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
    const resp = await axios.get(url, {
        headers: { "x-api-key": TAP_KEY, accept: "application/json" },
        params: q,
    });
    const raw = resp.data?.data ?? resp.data;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("No candle data returned from TapTools (check unit/interval/time window).");
    }
    return raw
        .map((k: any) => {
            const ts = normalizeTs(k.ts ?? k.time ?? k.timestamp);
            const close = Number(k.close ?? k.c);
            return { ts, close };
        })
        .filter((c: Candle) => Number.isFinite(c.close));
}
function normalizeTs(x: number) {
    if (!Number.isFinite(x)) return Date.now();
    return String(x).length < 13 ? x * 1000 : x;
}

/* ---------- dynamic sizing used in the sweep ---------- */
function computeDynamicSizesFromInventory(
    invA: number, invB: number, aIsAda: boolean,
    caps: { capA: number; capB: number },
    sizing: { maxPctA: number; maxPctB: number; minTrA: number; minTrB: number }
): { sizeA: number; sizeB: number } {

    let maxSpendA = invA;
    if (aIsAda) {
        maxSpendA = Math.max(0, invA - RESERVE_ADA_DEC - FEE_BUF_ADA);
    }

    const dynA = (sizing.maxPctA / 100) * maxSpendA;
    const dynB = (sizing.maxPctB / 100) * invB;

    const sizeA = Math.min(invA, clamp(dynA, sizing.minTrA, caps.capA));
    const sizeB = Math.min(invB, clamp(dynB, sizing.minTrB, caps.capB));

    return { sizeA, sizeB };
}
function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}

/* ---------- single run over a fixed series ---------- */
type SeriesPoint = { t: number; mid: number };

function runBacktest(
    series: SeriesPoint[],
    params: {
        bandBps: number; alpha: number; edgeBps: number; cooldownMs: number;
        capA: number; capB: number;
        maxPctA: number; maxPctB: number; minTrA: number; minTrB: number;
        aIsAda: boolean;
        decisionEveryMs: number; // cadence
        // new filter/stop params
        minCycleBps: number; trailBps: number; hardBps: number; estFeesBps: number;
    }
) {
    let invA = START_A;
    let invB = START_B;
    let center = series[0].mid;
    let lastTradeAt = 0;

    // cadence state
    let nextDecisionAt = 0;
    function alignNextDecision(ts: number) {
        if (params.decisionEveryMs <= 0) return;
        const bucket = Math.floor(ts / params.decisionEveryMs) + 1;
        nextDecisionAt = bucket * params.decisionEveryMs;
    }
    if (params.decisionEveryMs > 0) alignNextDecision(series[0].t);

    // position memory
    type PosMode = "LONG_A" | "LONG_B" | null;
    let posMode: PosMode = null;
    let entryMid = 0, peakMid = 0, troughMid = 0;
    const favMove = (m: number) =>
        posMode === "LONG_B" ? ((m - entryMid) / entryMid) * 10000 :
            posMode === "LONG_A" ? ((entryMid - m) / entryMid) * 10000 : 0;
    const trailDD = (m: number) =>
        posMode === "LONG_B" && peakMid > 0 ? ((peakMid - m) / peakMid) * 10000 :
            posMode === "LONG_A" && troughMid > 0 ? ((m - troughMid) / troughMid) * 10000 : 0;
    const hardLoss = (m: number) =>
        posMode === "LONG_B" ? ((entryMid - m) / entryMid) * 10000 :
            posMode === "LONG_A" ? ((m - entryMid) / entryMid) * 10000 : 0;
    const openPos = (pm: PosMode, m: number) => { posMode = pm; entryMid = peakMid = troughMid = m; };
    const closePos = () => { posMode = null; entryMid = peakMid = troughMid = 0; };

    let trades = 0, sellA = 0, sellB = 0, wins = 0, losses = 0;
    let peakMarked = invA + (invB / series[0].mid);
    let maxDD = 0;

    for (const { t, mid } of series) {
        center = params.alpha * mid + (1 - params.alpha) * center;
        const { lower, upper } = bounds(center, params.bandBps);

        if (posMode) { peakMid = Math.max(peakMid || mid, mid); troughMid = Math.min(troughMid || mid, mid); }

        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= params.edgeBps) action = "SELL_A";
        else if (mid < lower && underLower >= params.edgeBps) action = "SELL_B";

        // cadence gate
        if (params.decisionEveryMs > 0 && t < nextDecisionAt) {
            const marked = invA + (invB / mid);
            peakMarked = Math.max(peakMarked, marked);
            maxDD = Math.max(maxDD, peakMarked - marked);
            continue;
        }

        // forced close via stops
        let forcedClose: "SELL_A" | "SELL_B" | null = null;
        if (posMode) {
            const td = params.trailBps > 0 ? trailDD(mid) : -1;
            const hs = params.hardBps  > 0 ? hardLoss(mid) : -1;
            if ((params.trailBps > 0 && td >= params.trailBps) || (params.hardBps > 0 && hs >= params.hardBps)) {
                forcedClose = posMode === "LONG_B" ? "SELL_B" : "SELL_A";
            }
        }

        let planned: "HOLD" | "SELL_A" | "SELL_B" = forcedClose ?? action;

        // cooldown
        if (planned !== "HOLD" && params.cooldownMs > 0) {
            const remain = params.cooldownMs - (t - lastTradeAt);
            if (remain > 0) planned = "HOLD";
        }

        // disallow add-to-same-side
        if (posMode === "LONG_B" && planned === "SELL_A") planned = "HOLD";
        if (posMode === "LONG_A" && planned === "SELL_B") planned = "HOLD";

        // profit filter on cycle close
        if (posMode && ((posMode==="LONG_B" && planned==="SELL_B") || (posMode==="LONG_A" && planned==="SELL_A"))) {
            const need = params.minCycleBps + params.estFeesBps;
            if (favMove(mid) < need && !forcedClose) planned = "HOLD";
        }

        if (planned === "HOLD") {
            const marked = invA + (invB / mid);
            peakMarked = Math.max(peakMarked, marked);
            maxDD = Math.max(maxDD, peakMarked - marked);
            continue;
        }

        // Dynamic size
        const { sizeA, sizeB } = computeDynamicSizesFromInventory(
            invA, invB, params.aIsAda,
            { capA: params.capA, capB: params.capB },
            { maxPctA: params.maxPctA, maxPctB: params.maxPctB, minTrA: params.minTrA, minTrB: params.minTrB }
        );

        if (planned === "SELL_A") {
            if (sizeA <= 0 || invA <= 0) { const m = invA + (invB / mid); peakMarked = Math.max(peakMarked, m); maxDD = Math.max(maxDD, peakMarked - m); continue; }
            const rawOutB = mid * sizeA;
            if (MIN_NOTIONAL_OUT > 0 && rawOutB < MIN_NOTIONAL_OUT) { const m = invA + (invB / mid); peakMarked = Math.max(peakMarked, m); maxDD = Math.max(maxDD, peakMarked - m); continue; }
            const outB = applyFeesOut(rawOutB, TOTAL_FEE_BPS);
            const pnlAda = (outB / mid) - sizeA;

            invA -= sizeA;
            invB += outB;
            lastTradeAt = t;
            if (params.decisionEveryMs > 0) alignNextDecision(t);

            if (posMode === "LONG_A") closePos();
            if (posMode === null) openPos("LONG_B", mid);

            trades++; sellA++; if (pnlAda > 0) wins++; else if (pnlAda < 0) losses++;

        } else {
            if (sizeB <= 0 || invB <= 0) { const m = invA + (invB / mid); peakMarked = Math.max(peakMarked, m); maxDD = Math.max(maxDD, peakMarked - m); continue; }
            const rawOutA = sizeB / mid;
            if (MIN_NOTIONAL_OUT > 0 && rawOutA < MIN_NOTIONAL_OUT) { const m = invA + (invB / mid); peakMarked = Math.max(peakMarked, m); maxDD = Math.max(maxDD, peakMarked - m); continue; }
            const outA = applyFeesOut(rawOutA, TOTAL_FEE_BPS);
            const pnlAda = outA - (sizeB / mid);

            invB -= sizeB;
            invA += outA;
            lastTradeAt = t;
            if (params.decisionEveryMs > 0) alignNextDecision(t);

            if (posMode === "LONG_B") closePos();
            if (posMode === null) openPos("LONG_A", mid);

            trades++; sellB++; if (pnlAda > 0) wins++; else if (pnlAda < 0) losses++;
        }

        const marked = invA + (invB / mid);
        peakMarked = Math.max(peakMarked, marked);
        maxDD = Math.max(maxDD, peakMarked - marked);
    }

    const lastMid = series[series.length - 1].mid;
    const endMarked = invA + (invB / lastMid);
    const startMarked = START_A + (START_B / series[0].mid);
    const pnlAda = endMarked - startMarked;
    const winrate = trades > 0 ? wins / trades : 0;
    const avgPnL = trades > 0 ? pnlAda / trades : 0;

    return {
        endA: invA, endB: invB, endMarked, pnlAda, maxDD,
        trades, sellA, sellB, wins, losses, winrate, avgPnL
    };
}

/* ---------- main sweep ---------- */
async function main() {
    // Resolve units
    const unitA = TOKEN_A_Q.toUpperCase() === "ADA" ? "lovelace" : await resolveTokenId(TOKEN_A_Q);
    const unitB = await resolveTokenId(TOKEN_B_Q);
    const vsUnit = unitA === "lovelace" ? "lovelace" : unitA;

    // Fetch candles once
    const candles = await fetchCandlesTapTools({
        unitBase: unitB,
        vsUnit,
        interval: INTERVAL,
        limit: MAX_CANDLES,
        start: START_EPOCH || undefined,
        end: END_EPOCH || undefined,
    });
    if (!candles.length) throw new Error("No candles returned.");

    // Build mid series
    const baseSeries = candles
        .map(c => ({ t: c.ts, mid: Number(c.close) }))
        .filter(p => Number.isFinite(p.mid))
        .sort((a,b) => a.t - b.t);

    if (!PRICE_IS_B_PER_A) {
        for (const p of baseSeries) p.mid = 1 / p.mid;
    }

    const points = baseSeries.length;
    console.log(`Candles: ${points} | interval=${INTERVAL} | pair A=${TOKEN_A_Q}(${unitA}) / B=${TOKEN_B_Q}(${unitB})`);

    const tsRun = new Date().toISOString();

    // Grid (includes cadence + filters/stops)
    for (const bandBps of BAND_BPS_LIST) {
        for (const edgeBps of EDGE_BPS_LIST) {
            for (const alpha of ALPHA_LIST) {
                for (const maxPctA of MAX_PCT_A_LIST) {
                    for (const maxPctB of MAX_PCT_B_LIST) {
                        for (const minTrA of MIN_TR_A_LIST) {
                            for (const minTrB of MIN_TR_B_LIST) {
                                for (const cooldownMs of COOLDOWN_LIST) {
                                    for (const decisionMs of DECISION_MS_LIST) {
                                        for (const minCycleBps of MIN_CYCLE_BPS_LIST) {
                                            for (const trailBps of TRAIL_BPS_LIST) {
                                                for (const hardBps of HARD_BPS_LIST) {

                                                    const res = runBacktest(baseSeries, {
                                                        bandBps, alpha, edgeBps, cooldownMs,
                                                        capA: CAP_A, capB: CAP_B,
                                                        maxPctA, maxPctB, minTrA, minTrB,
                                                        aIsAda: TOKEN_A_Q.toUpperCase() === "ADA",
                                                        decisionEveryMs: decisionMs,
                                                        minCycleBps, trailBps, hardBps, estFeesBps: EST_FEES_BPS,
                                                    });

                                                    appendCsv(OUT, [
                                                        tsRun, INTERVAL, points,
                                                        TOKEN_A_Q, TOKEN_B_Q,
                                                        bandBps, edgeBps, alpha,
                                                        maxPctA, maxPctB, minTrA, minTrB,
                                                        CAP_A, CAP_B, RESERVE_ADA_DEC, POOL_FEE_BPS, EXTRA_AGG_FEE_BPS, cooldownMs,
                                                        decisionMs, minCycleBps, trailBps, hardBps, EST_FEES_BPS,
                                                        START_A, START_B,
                                                        fix(res.endA, 6), fix(res.endB, 6), fix(res.endMarked, 6), fix(res.pnlAda, 6), fix(res.maxDD, 6),
                                                        res.trades, res.sellA, res.sellB, res.wins, res.losses, fix(res.winrate, 4), fix(res.avgPnL, 6),
                                                    ]);

                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    console.log(`Sweep complete → ${OUT}`);
}

main().catch((err) => {
    console.error(err?.response?.data ?? err);
});
