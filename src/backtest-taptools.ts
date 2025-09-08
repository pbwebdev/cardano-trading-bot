// src/backtest-taptools.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Backtests the EMA-band strategy to match src/bot-twoway.ts behavior.
 * - mid = TOKEN_B per TOKEN_A (same as live bot)
 * - EMA(BAND_ALPHA), BAND_BPS, EDGE_BPS, MIN_NOTIONAL_OUT guard, ONLY_VERIFIED
 * - Optional cooldown in backtest via BT_COOLDOWN_MS (default 0)
 * - Trades sized by AMOUNT_A_DEC / AMOUNT_B_DEC in human units
 * - Fees modeled via BT_POOL_FEE_BPS + BT_AGG_FEE_BPS (defaults 30 + 0)
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// Strategy envs (match bot)
const BAND_BPS   = num(process.env.BAND_BPS, 50);
const BAND_ALPHA = num(process.env.BAND_ALPHA, 0.10);
const EDGE_BPS   = num(process.env.EDGE_BPS, 5);
const MIN_NOTIONAL_OUT = num(process.env.MIN_NOTIONAL_OUT, 0); // guard on min_out (human)
const ONLY_VERIFIED = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// Sizing (human units)
const AMOUNT_A_DEC = num(process.env.AMOUNT_A_DEC, 10);
const AMOUNT_B_DEC = num(process.env.AMOUNT_B_DEC, 100);

// Pair
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim(); // "ADA" or unit
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim(); // ticker or unit

// TapTools request
const TAP_BASE     = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY      = process.env.TAPTOOLS_API_KEY!;
const INTERVAL     = (process.env.BT_INTERVAL ?? "1h").trim();
const MAX_CANDLES  = num(process.env.BT_MAX_POINTS, 3000);
const START_EPOCH  = num(process.env.BT_START_EPOCH, 0); // ms epoch (optional)
const END_EPOCH    = num(process.env.BT_END_EPOCH, 0);   // ms epoch (optional)
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "true").toLowerCase() === "true";

// Fees (bps)
const POOL_FEE_BPS      = num(process.env.BT_POOL_FEE_BPS, 30); // 0.30%
const EXTRA_AGG_FEE_BPS = num(process.env.BT_AGG_FEE_BPS, 0);

// Optional backtest cooldown (ms) – to reflect live behavior
const BT_COOLDOWN_MS    = num(process.env.BT_COOLDOWN_MS, 0);

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
    // policyId(56 hex) + '.' + asset name hex
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

/** Fetch candles from TapTools. We request price quoted vs ADA (lovelace) when possible. */
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
        onchainID: params.unitBase, // some plans use this key
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
    // seconds vs ms heuristic
    if (!Number.isFinite(x)) return Date.now();
    return String(x).length < 13 ? x * 1000 : x;
}

/* ---------- backtest ---------- */
async function main() {
    // Resolve units to align with bot
    const unitA = TOKEN_A_Q.toUpperCase() === "ADA" ? "lovelace" : await resolveTokenId(TOKEN_A_Q);
    const unitB = await resolveTokenId(TOKEN_B_Q);

    // We want mid = TOKEN_B per TOKEN_A. If A=ADA, fetch B/ADA candles (vs_unit = lovelace).
    // If A != ADA, we still fetch B quoted in vsUnit = unitA when possible; else you can invert per flag.
    const vsUnit = unitA === "lovelace" ? "lovelace" : unitA;

    const candles = await fetchCandlesTapTools({
        unitBase: unitB,          // price series for TOKEN_B
        vsUnit,                   // quoted vs TOKEN_A (ideally ADA/lovelace)
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

    // Ensure mid = B per A (same as live bot)
    if (!PRICE_IS_B_PER_A) {
        for (const p of series) p.mid = 1 / p.mid;
    }

    console.log(
        `Backtest pair: A=${TOKEN_A_Q} (${unitA})  B=${TOKEN_B_Q} -> ${unitB}\n` +
        `Points=${series.length}  | interval=${INTERVAL} | BAND_BPS=${BAND_BPS} ALPHA=${BAND_ALPHA} EDGE_BPS=${EDGE_BPS}\n` +
        `Sizes: A=${AMOUNT_A_DEC}  B=${AMOUNT_B_DEC}  | Fees: pool=${POOL_FEE_BPS}bps agg=${EXTRA_AGG_FEE_BPS}bps\n`
    );

    // Sim state
    let invA = num(process.env.BT_START_ADA, 100);      // start A (ADA) human units
    let invB = num(process.env.BT_START_TOKB, 0);       // start B human units
    const totalFeeBps = POOL_FEE_BPS + EXTRA_AGG_FEE_BPS;

    // EMA center & cooldown
    let center = series[0].mid;
    let lastTradeAt = 0;

    let rollingMarkedAda = invA + (invB / series[0].mid);

    for (const { t, mid } of series) {
        // EMA update
        center = BAND_ALPHA * mid + (1 - BAND_ALPHA) * center;
        const { lower, upper } = bounds(center, BAND_BPS);

        // decision like bot
        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= EDGE_BPS) action = "SELL_A";
        else if (mid < lower && underLower >= EDGE_BPS) action = "SELL_B";

        // cooldown
        if (action !== "HOLD" && BT_COOLDOWN_MS > 0) {
            const remain = BT_COOLDOWN_MS - (t - lastTradeAt);
            if (remain > 0) action = "HOLD";
        }

        if (action === "HOLD") {
            rollingMarkedAda = invA + (invB / mid);
            continue;
        }

        if (action === "SELL_A") {
            if (invA < AMOUNT_A_DEC) { rollingMarkedAda = invA + (invB / mid); continue; }
            // min_out (B) for selling A at mid: raw = mid * size; guard by MIN_NOTIONAL_OUT
            const rawOutB = mid * AMOUNT_A_DEC;
            if (MIN_NOTIONAL_OUT > 0 && rawOutB < MIN_NOTIONAL_OUT) {
                rollingMarkedAda = invA + (invB / mid);
                continue;
            }
            const outB = applyFeesOut(rawOutB, totalFeeBps);

            // PnL in ADA at decision mid:
            // value of B received in ADA minus ADA spent
            const pnlAda = (outB / mid) - AMOUNT_A_DEC;

            invA -= AMOUNT_A_DEC;
            invB += outB;
            lastTradeAt = t;

            rollingMarkedAda = invA + (invB / mid);

            appendCsv(OUT, [
                new Date(t).toISOString(),
                "SELL_A",
                mid,
                center,
                lower,
                upper,
                AMOUNT_A_DEC,
                TOKEN_A_Q,
                outB,
                TOKEN_B_Q,
                totalFeeBps,
                pnlAda,
                rollingMarkedAda
            ]);
        } else {
            if (invB < AMOUNT_B_DEC) { rollingMarkedAda = invA + (invB / mid); continue; }
            // min_out (A) for selling B at mid: raw = B / mid
            const rawOutA = AMOUNT_B_DEC / mid;
            if (MIN_NOTIONAL_OUT > 0 && rawOutA < MIN_NOTIONAL_OUT) {
                rollingMarkedAda = invA + (invB / mid);
                continue;
            }
            const outA = applyFeesOut(rawOutA, totalFeeBps);

            // PnL in ADA:
            // ADA received minus ADA value of B sold at mid
            const pnlAda = outA - (AMOUNT_B_DEC / mid);

            invB -= AMOUNT_B_DEC;
            invA += outA;
            lastTradeAt = t;

            rollingMarkedAda = invA + (invB / mid);

            appendCsv(OUT, [
                new Date(t).toISOString(),
                "SELL_B",
                mid,
                center,
                lower,
                upper,
                AMOUNT_B_DEC,
                TOKEN_B_Q,
                outA,
                TOKEN_A_Q,
                totalFeeBps,
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
