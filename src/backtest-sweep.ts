// src/backtest-sweep.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Parameter sweep backtest aligned with bot-twoway + backtest-taptools:
 * - mid = TOKEN_B per TOKEN_A
 * - EMA(BAND_ALPHA), BAND_BPS, EDGE_BPS, MIN_NOTIONAL_OUT guard
 * - Optional cooldown per combo
 * - Fees modeled via BT_POOL_FEE_BPS + BT_AGG_FEE_BPS
 * - Reads sweep lists from env (comma-separated)
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// Pair
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim();
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim();
const ONLY_VERIFIED = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// TapTools
const TAP_BASE = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY = process.env.TAPTOOLS_API_KEY!;
const INTERVAL = (process.env.BT_INTERVAL ?? "1h").trim();
const MAX_CANDLES = num(process.env.BT_MAX_POINTS, 1500);
const START_EPOCH = num(process.env.BT_START_EPOCH, 0); // ms
const END_EPOCH = num(process.env.BT_END_EPOCH, 0);     // ms
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "true").toLowerCase() === "true";

// Fees
const POOL_FEE_BPS = num(process.env.BT_POOL_FEE_BPS, 30);
const EXTRA_AGG_FEE_BPS = num(process.env.BT_AGG_FEE_BPS, 0);

// Starting balances (human units)
const START_A = num(process.env.BT_START_ADA, 1000);
const START_B = num(process.env.BT_START_TOKB, 0);

// Sweeps (comma-separated lists)
const BAND_BPS_LIST = listNum(process.env.SWEEP_BAND_BPS ?? "80,120,160");
const ALPHA_LIST = listNum(process.env.SWEEP_BAND_ALPHA ?? "0.04,0.06,0.08");
const EDGE_LIST = listNum(process.env.SWEEP_EDGE_BPS ?? "15,25,35");
const AMT_A_LIST = listNum(process.env.SWEEP_AMOUNT_A_DEC ?? "25,50");
const AMT_B_LIST = listNum(process.env.SWEEP_AMOUNT_B_DEC ?? "25,50");

// Optional sweeps
const MIN_NOTIONAL_LIST = listNum(process.env.SWEEP_MIN_NOTIONAL_OUT ?? "0");   // human units of token_out
const COOL_MS_LIST = listNum(process.env.SWEEP_BT_COOLDOWN_MS ?? "0");          // ms

// Output
const OUT = path.join(process.cwd(), "sweep_results.csv");
ensureCsvHeader(
    OUT,
    [
        "band_bps",
        "alpha",
        "edge_bps",
        "amount_a",
        "amount_b",
        "min_notional_out",
        "cooldown_ms",
        "trades",
        "end_marked_ada",
        "pnl_ada_abs",
        "pnl_ada_pct",
        "max_drawdown_pct",
        "sharpe_like",
        "winrate_pct",
        "avg_trade_pnl_ada",
        "median_trade_pnl_ada",
    ].join(",") + "\n"
);

const AGG = "https://agg-api.minswap.org/aggregator";

/* ----------------- helpers ----------------- */
function num(x: any, def: number): number {
    const n = Number(x);
    return Number.isFinite(n) ? n : def;
}
function listNum(s: string): number[] {
    return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n));
}
function isUnit(u: string) {
    return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(u);
}
function ensureCsvHeader(file: string, header: string) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, header, "utf8");
}
function appendCsv(file: string, row: any[]) {
    fs.appendFileSync(file, row.join(",") + "\n", "utf8");
}
function bpsOver(x: number, y: number) {
    return ((x - y) / y) * 10000;
}
function bounds(center: number, bps: number) {
    return { lower: center * (1 - bps / 10000), upper: center * (1 + bps / 10000) };
}
function applyFeesOut(amountOut: number, totalFeeBps: number) {
    return amountOut * (1 - totalFeeBps / 10000);
}
function normalizeTs(x: number) {
    if (!Number.isFinite(x)) return Date.now();
    return String(x).length < 13 ? x * 1000 : x;
}
function percentile(arr: number[], p: number) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const idx = Math.floor((p / 100) * (a.length - 1));
    return a[idx];
}
function median(arr: number[]) {
    return percentile(arr, 50);
}
function mean(arr: number[]) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function stddev(arr: number[]) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v = mean(arr.map((x) => (x - m) ** 2));
    return Math.sqrt(v);
}

/** Resolve a token via Minswap Agg (like bot). */
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

/** Fetch candles once for B quoted vs A (prefer ADA=lovelace). */
async function fetchCandlesTapTools(params: {
    unitBase: string; // TOKEN_B unit
    vsUnit: string;   // quote denom (TOKEN_A unit)
    interval: string;
    limit: number;
    start?: number; // ms
    end?: number;   // ms
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
    if (params.end && params.end > 0) q.end = Math.floor(params.end / 1000);

    const url = `${TAP_BASE}${PATH}`;
    const resp = await axios.get(url, {
        headers: { "x-api-key": TAP_KEY, accept: "application/json" },
        params: q,
    });
    const raw = resp.data?.data ?? resp.data;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error("No candle data from TapTools; check unit/interval/window.");
    }
    const candles: Candle[] = raw
        .map((k: any) => ({
            ts: normalizeTs(k.ts ?? k.time ?? k.timestamp),
            open: Number(k.open ?? k.o),
            high: Number(k.high ?? k.h),
            low: Number(k.low ?? k.l),
            close: Number(k.close ?? k.c),
            volume: k.volume ?? k.v,
        }))
        .filter((c) => Number.isFinite(c.close));
    return candles;
}

/* -------------- core sim (one combo) -------------- */
type Combo = {
    bandBps: number;
    alpha: number;
    edgeBps: number;
    amountA: number;
    amountB: number;
    minNotionalOut: number;
    cooldownMs: number;
};
type SimResult = {
    trades: number;
    endMarkedAda: number;
    pnlAbs: number;
    pnlPct: number;
    maxDDPct: number;
    sharpeLike: number;
    winratePct: number;
    avgTradePnlAda: number;
    medianTradePnlAda: number;
};

function runCombo(series: { t: number; mid: number }[], combo: Combo): SimResult {
    let invA = START_A;
    let invB = START_B;
    const feeBps = POOL_FEE_BPS + EXTRA_AGG_FEE_BPS;

    let center = series[0].mid;
    let lastTradeAt = 0;

    const tradePnLs: number[] = [];
    const rolling: number[] = []; // marked ADA equity curve

    for (const { t, mid } of series) {
        // Update EMA center
        center = combo.alpha * mid + (1 - combo.alpha) * center;
        const { lower, upper } = bounds(center, combo.bandBps);

        // Decide like bot
        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= combo.edgeBps) action = "SELL_A";
        else if (mid < lower && underLower >= combo.edgeBps) action = "SELL_B";

        // Cooldown
        if (action !== "HOLD" && combo.cooldownMs > 0) {
            const remain = combo.cooldownMs - (t - lastTradeAt);
            if (remain > 0) action = "HOLD";
        }

        if (action === "SELL_A") {
            if (invA < combo.amountA) {
                rolling.push(invA + invB / mid);
                continue;
            }
            const rawOutB = mid * combo.amountA;
            if (combo.minNotionalOut > 0 && rawOutB < combo.minNotionalOut) {
                rolling.push(invA + invB / mid);
                continue;
            }
            const outB = applyFeesOut(rawOutB, feeBps);
            const pnlAda = (outB / mid) - combo.amountA;

            invA -= combo.amountA;
            invB += outB;
            lastTradeAt = t;

            tradePnLs.push(pnlAda);
            rolling.push(invA + invB / mid);
        } else if (action === "SELL_B") {
            if (invB < combo.amountB) {
                rolling.push(invA + invB / mid);
                continue;
            }
            const rawOutA = combo.amountB / mid;
            if (combo.minNotionalOut > 0 && rawOutA < combo.minNotionalOut) {
                rolling.push(invA + invB / mid);
                continue;
            }
            const outA = applyFeesOut(rawOutA, feeBps);
            const pnlAda = outA - (combo.amountB / mid);

            invB -= combo.amountB;
            invA += outA;
            lastTradeAt = t;

            tradePnLs.push(pnlAda);
            rolling.push(invA + invB / mid);
        } else {
            rolling.push(invA + invB / mid);
        }
    }

    const lastMid = series[series.length - 1].mid;
    const endMarkedAda = invA + invB / lastMid;

    const startMarkedAda = START_A + (START_B / series[0].mid);
    const pnlAbs = endMarkedAda - startMarkedAda;
    const pnlPct = startMarkedAda > 0 ? (pnlAbs / startMarkedAda) * 100 : 0;

    const maxDDPct = computeMaxDrawdownPct(rolling);
    const sharpeLike = computeSharpeLike(rolling); // per-step

    const wins = tradePnLs.filter((x) => x > 0).length;
    const winratePct = tradePnLs.length ? (wins / tradePnLs.length) * 100 : 0;

    return {
        trades: tradePnLs.length,
        endMarkedAda,
        pnlAbs,
        pnlPct,
        maxDDPct,
        sharpeLike,
        winratePct,
        avgTradePnlAda: tradePnLs.length ? mean(tradePnLs) : 0,
        medianTradePnlAda: tradePnLs.length ? median(tradePnLs) : 0,
    };
}

function computeMaxDrawdownPct(equity: number[]): number {
    if (!equity.length) return 0;
    let peak = equity[0];
    let maxDD = 0;
    for (const v of equity) {
        if (v > peak) peak = v;
        const dd = (peak - v) / peak;
        if (dd > maxDD) maxDD = dd;
    }
    return maxDD * 100;
}

function computeSharpeLike(equity: number[]): number {
    if (equity.length < 3) return 0;
    // per-step returns
    const rets: number[] = [];
    for (let i = 1; i < equity.length; i++) {
        const prev = equity[i - 1];
        const curr = equity[i];
        if (prev > 0) rets.push((curr - prev) / prev);
    }
    if (rets.length < 2) return 0;
    const m = mean(rets);
    const s = stddev(rets);
    return s > 0 ? m / s : 0;
}

/* ----------------- main ----------------- */
async function main() {
    // Resolve units like bot
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
    const series = candles
        .map((c) => ({ t: c.ts, mid: Number(c.close) }))
        .filter((p) => Number.isFinite(p.mid))
        .sort((a, b) => a.t - b.t);

    if (!PRICE_IS_B_PER_A) {
        for (const p of series) p.mid = 1 / p.mid; // ensure B per A
    }

    console.log(
        `Sweep on A=${TOKEN_A_Q} (${unitA})  B=${TOKEN_B_Q} -> ${unitB}\n` +
        `Points=${series.length} | interval=${INTERVAL} | fees=${POOL_FEE_BPS + EXTRA_AGG_FEE_BPS}bps`
    );

    // Generate combos
    const combos: Combo[] = [];
    for (const bandBps of BAND_BPS_LIST) {
        for (const alpha of ALPHA_LIST) {
            for (const edgeBps of EDGE_LIST) {
                for (const amountA of AMT_A_LIST) {
                    for (const amountB of AMT_B_LIST) {
                        for (const minNotionalOut of MIN_NOTIONAL_LIST) {
                            for (const cooldownMs of COOL_MS_LIST) {
                                combos.push({ bandBps, alpha, edgeBps, amountA, amountB, minNotionalOut, cooldownMs });
                            }
                        }
                    }
                }
            }
        }
    }

    console.log(`Combos: ${combos.length}`);

    for (const c of combos) {
        const res = runCombo(series, c);
        appendCsv(OUT, [
            c.bandBps,
            fix(c.alpha, 4),
            c.edgeBps,
            fix(c.amountA, 6),
            fix(c.amountB, 6),
            fix(c.minNotionalOut, 6),
            c.cooldownMs,
            res.trades,
            fix(res.endMarkedAda, 6),
            fix(res.pnlAbs, 6),
            fix(res.pnlPct, 3),
            fix(res.maxDDPct, 3),
            fix(res.sharpeLike, 4),
            fix(res.winratePct, 2),
            fix(res.avgTradePnlAda, 6),
            fix(res.medianTradePnlAda, 6),
        ]);
    }

    console.log(`Wrote: ${OUT}`);
}

function fix(x: any, d: number) {
    const n = Number(x);
    if (!Number.isFinite(n)) return String(x);
    return n.toFixed(d);
}

main().catch((err) => {
    console.error(err?.response?.data ?? err);
});
