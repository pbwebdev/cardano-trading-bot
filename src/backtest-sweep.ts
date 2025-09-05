// src/backtest-sweep.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Backtest parameter sweep for your EMA-band mean-reversion bot (ADA <-> TOKEN_B).
 * - Fetches historical candles from TapTools
 * - Resolves TOKEN_B symbol -> on-chain unit via Minswap Aggregator
 * - Runs a grid of parameters and writes a leaderboard CSV
 *
 * ENV you likely already have:
 *  NETWORK=Mainnet
 *  TAPTOOLS_API_KEY=...
 *  TOKEN_A=ADA
 *  TOKEN_B=USDM   # or USDA; symbol is ok (looked up via Minswap)
 *  ONLY_VERIFIED=true
 *  BT_INTERVAL=1h
 *  BT_MAX_POINTS=1000
 *  BT_START_ADA=1000
 *  BT_START_TOKB=0
 *  BT_PRICE_IS_B_PER_A=false   # set true if your candles are already B per A
 *  BT_POOL_FEE_BPS=30
 *  BT_AGG_FEE_BPS=0
 *
 * Sweep ranges (CSV lists):
 *  SWEEP_BAND_BPS=80,120,160
 *  SWEEP_BAND_ALPHA=0.04,0.06,0.08
 *  SWEEP_EDGE_BPS=15,25,35
 *  SWEEP_AMOUNT_A_DEC=25,50
 *  SWEEP_AMOUNT_B_DEC=25,50
 *
 * Optional time window (ms epoch):
 *  BT_START_EPOCH=0
 *  BT_END_EPOCH=0
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// Pair
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim(); // base (typically ADA)
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim(); // quote (symbol or unit)

// TapTools
const TAP_BASE = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY  = process.env.TAPTOOLS_API_KEY!;
if (!TAP_KEY) {
    throw new Error("Missing TAPTOOLS_API_KEY in env");
}

// Minswap Aggregator (for token lookup)
const AGG = "https://agg-api.minswap.org/aggregator";
const ONLY_VERI = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// Candle request
const INTERVAL    = (process.env.BT_INTERVAL ?? "1h").trim();  // 1m/5m/1h/4h/1d...
const MAX_POINTS  = num(process.env.BT_MAX_POINTS, 1000);
const START_EPOCH = num(process.env.BT_START_EPOCH, 0);
const END_EPOCH   = num(process.env.BT_END_EPOCH, 0);

// Fees assumed by backtest
const POOL_FEE_BPS = num(process.env.BT_POOL_FEE_BPS, 30);
const AGG_FEE_BPS  = num(process.env.BT_AGG_FEE_BPS, 0);

// Price orientation
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "false").toLowerCase() === "true";

// Start balances
const START_ADA  = num(process.env.BT_START_ADA, 1000);
const START_TOKB = num(process.env.BT_START_TOKB, 0);

// Sweep ranges (CSV lists)
const SWEEP_BAND_BPS    = listNum(process.env.SWEEP_BAND_BPS,    [80, 120, 160]);
const SWEEP_BAND_ALPHA  = listNum(process.env.SWEEP_BAND_ALPHA,  [0.04, 0.06, 0.08]);
const SWEEP_EDGE_BPS    = listNum(process.env.SWEEP_EDGE_BPS,    [15, 25, 35]);
const SWEEP_AMOUNT_A    = listNum(process.env.SWEEP_AMOUNT_A_DEC,[25, 50]);
const SWEEP_AMOUNT_B    = listNum(process.env.SWEEP_AMOUNT_B_DEC,[25, 50]);

// Output
const OUT = path.join(process.cwd(), "sweep_results.csv");
ensureHeader(OUT, [
    "tokenA","tokenB_unit","interval","points",
    "band_bps","alpha","edge_bps","amtA","amtB",
    "trades","wins","losses","win_rate",
    "total_pnl_ada","median_pnl","mean_pnl",
    "profit_factor","max_drawdown_ada","final_ada","last_mid"
]);

/* ---------- Helpers ---------- */

function num(s: string | undefined, dflt: number): number {
    const n = Number(s);
    return Number.isFinite(n) ? n : dflt;
}
function listNum(s: string | undefined, dflt: number[]): number[] {
    if (!s) return dflt;
    const arr = s.split(",").map(x => Number(x.trim())).filter(x => Number.isFinite(x));
    return arr.length ? arr : dflt;
}
function ensureHeader(file: string, cols: string[]) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, cols.join(",") + "\n", "utf8");
    }
}
function isUnit(s: string) {
    // Accept both policyId.assetNameHex and concatenated policy+asset hex (some APIs use either)
    return /^[0-9a-f]{56}(\.[0-9a-f]+)?$/i.test(s);
}
async function resolveTokenUnitViaMinswap(query: string, onlyVerified: boolean): Promise<string> {
    // if it's already a unit, return as-is (normalize "ADA" to lovelace)
    if (query.toUpperCase() === "ADA") return "lovelace";
    if (isUnit(query)) return query.includes(".") ? query : query; // already hex

    const resp = await axios.post(`${AGG}/tokens`, { query, only_verified: onlyVerified });
    const items: any[] = resp.data?.tokens ?? [];
    if (!items.length) throw new Error(`Token not found via Minswap lookup: ${query}`);
    const exact = items.find(t => (t.ticker || "").toLowerCase() === query.toLowerCase());
    const chosen = exact ?? items[0];
    if (!chosen.token_id) throw new Error(`No token_id returned for: ${query}`);
    console.log(`Resolved ${query} -> ${chosen.token_id} (${chosen.ticker ?? ""})`);
    return chosen.token_id; // policy.asset hex
}

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume?: number };

async function fetchCandlesTapTools(params: {
    tokenB_unit: string; // the token whose price history we pull
    vs_unit: string;     // the quote unit (lovelace if ADA is quote)
    interval: string;
    limit: number;
    start?: number;
    end?: number;
}): Promise<Candle[]> {
    const PATH = "/api/v1/token/ohlcv";
    const url  = `${TAP_BASE}${PATH}`;

    const q: Record<string, any> = {
        unit: params.tokenB_unit,
        onchainID: params.tokenB_unit,
        vs_unit: params.vs_unit,
        interval: params.interval,
        limit: params.limit,
    };
    if (params.start && params.start > 0) q.start = Math.floor(params.start / 1000);
    if (params.end && params.end > 0)     q.end   = Math.floor(params.end   / 1000);

    try {
        const resp = await axios.get(url, {
            headers: { "x-api-key": TAP_KEY, accept: "application/json" },
            params: q,
        });
        const raw = resp.data?.data ?? resp.data;
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error("No candle data returned from TapTools.");
        }
        const candles: Candle[] = raw.map((k: any) => ({
            ts: (k.ts ?? k.time ?? k.timestamp) * (String(k.ts ?? k.time ?? k.timestamp).length < 13 ? 1000 : 1),
            open: Number(k.open ?? k.o),
            high: Number(k.high ?? k.h),
            low:  Number(k.low  ?? k.l),
            close:Number(k.close?? k.c),
            volume: k.volume ?? k.v,
        })).filter((c: Candle) => Number.isFinite(c.close));
        return candles;
    } catch (e: any) {
        console.error("TapTools request failed", {
            url,
            params: q,
            status: e?.response?.status,
            data: e?.response?.data,
        });
        throw e;
    }
}

function bounds(center: number, bps: number) {
    return { lower: center * (1 - bps / 10000), upper: center * (1 + bps / 10000) };
}
function bpsOver(x: number, y: number) { return ((x - y) / y) * 10000; }
function applyFeesOut(amountOut: number, totalFeeBps: number) {
    return amountOut * (1 - totalFeeBps / 10000);
}

type RunParams = {
    band_bps: number;
    alpha: number;
    edge_bps: number;
    amtA: number;
    amtB: number;
};

type RunResult = {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    medianPnl: number;
    meanPnl: number;
    profitFactor: number;
    maxDD: number;
    finalADA: number;
    lastMid: number;
};

function median(arr: number[]): number {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

function runBacktest(series: {t:number; mid:number}[], p: RunParams): RunResult {
    let center = series[0].mid; // seed EMA
    let invADA  = START_ADA;
    let invTOKB = START_TOKB;

    const pnlPerTrade: number[] = [];
    let equity = START_ADA + (invTOKB / series[0].mid);
    let peak   = equity;
    let maxDD  = 0;

    const totalFeeBps = POOL_FEE_BPS + AGG_FEE_BPS;

    let wins = 0, losses = 0;

    for (const { t, mid } of series) {
        // update EMA center
        center = p.alpha * mid + (1 - p.alpha) * center;
        const { lower, upper } = bounds(center, p.band_bps);

        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= p.edge_bps) action = "SELL_A";     // sell ADA -> get B
        else if (mid < lower && underLower >= p.edge_bps) action = "SELL_B"; // sell B -> get ADA

        if (action === "HOLD") {
            // update equity/drawdown path even on no-trade
            const markADA = invADA + invTOKB / mid;
            equity = markADA;
            peak = Math.max(peak, equity);
            maxDD = Math.min(maxDD, equity - peak);
            continue;
        }

        if (action === "SELL_A") {
            if (invADA < p.amtA) {
                // mark and move on
                const markADA = invADA + invTOKB / mid;
                equity = markADA; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
                continue;
            }
            const rawOutB = mid * p.amtA;
            const outB    = applyFeesOut(rawOutB, totalFeeBps);
            invADA  -= p.amtA;
            invTOKB += outB;

            // realized PnL for SELL_A:
            // starting ADA reduces by amtA, but you gain B that, if liquidated at mid immediately, is outB / mid ADA
            const pnl = -p.amtA + (outB / mid);
            pnlPerTrade.push(pnl);
            pnl >= 0 ? wins++ : losses++;

        } else if (action === "SELL_B") {
            if (invTOKB < p.amtB) {
                const markADA = invADA + invTOKB / mid;
                equity = markADA; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
                continue;
            }
            const rawOutA = p.amtB / mid;
            const outA    = applyFeesOut(rawOutA, totalFeeBps);
            invTOKB -= p.amtB;
            invADA  += outA;

            // realized PnL for SELL_B:
            // you give up B (valued at p.amtB / mid ADA) and receive outA ADA
            const pnl = outA - (p.amtB / mid);
            pnlPerTrade.push(pnl);
            pnl >= 0 ? wins++ : losses++;
        }

        // update equity/drawdown after each trade at current mid (mark to market)
        const markADA = invADA + invTOKB / mid;
        equity = markADA;
        peak = Math.max(peak, equity);
        maxDD = Math.min(maxDD, equity - peak);
    }

    const lastMid = series[series.length - 1].mid;
    const finalADA = invADA + invTOKB / lastMid;

    const totalPnl = pnlPerTrade.reduce((s, x) => s + x, 0);
    const positives = pnlPerTrade.filter(x => x > 0).reduce((s, x) => s + x, 0);
    const negatives = pnlPerTrade.filter(x => x < 0).reduce((s, x) => s + Math.abs(x), 0);
    const profitFactor = negatives > 0 ? positives / negatives : (positives > 0 ? Infinity : 0);
    const meanPnl = pnlPerTrade.length ? totalPnl / pnlPerTrade.length : 0;
    const medPnl  = median(pnlPerTrade);
    const trades  = pnlPerTrade.length;
    const winRate = trades ? wins / trades : 0;

    return {
        trades,
        wins,
        losses,
        winRate,
        totalPnl,
        medianPnl: medPnl,
        meanPnl,
        profitFactor,
        maxDD: Math.abs(maxDD), // positive number of ADA drawdown
        finalADA,
        lastMid
    };
}

/* ---------- Main ---------- */

async function main() {
    // Resolve TOKEN_B symbol -> unit via Minswap (or pass through if already unit)
    const tokenB_unit = await resolveTokenUnitViaMinswap(TOKEN_B_Q, ONLY_VERI);

    // vs_unit: if TOKEN_A is ADA, quote in lovelace (ADA)
    const vs_unit = TOKEN_A_Q.toUpperCase() === "ADA" ? "lovelace" : TOKEN_A_Q;

    // Fetch candles for TOKEN_B vs ADA
    const candles = await fetchCandlesTapTools({
        tokenB_unit,
        vs_unit,
        interval: INTERVAL,
        limit: Math.max(100, Math.min(5000, MAX_POINTS)),
        start: START_EPOCH || undefined,
        end: END_EPOCH || undefined,
    });

    // Convert to series of mid = TOKEN_B per TOKEN_A
    const series = candles
        .map(c => ({ t: c.ts, mid: Number(c.close) }))
        .filter(p => Number.isFinite(p.mid))
        .sort((a, b) => a.t - b.t);

    if (!series.length) throw new Error("No valid candles / closes for series.");

    if (!PRICE_IS_B_PER_A) {
        // If prices are ADA per B, flip to B per ADA
        for (const p of series) p.mid = 1 / p.mid;
    }

    const combos: RunParams[] = [];
    for (const band_bps of SWEEP_BAND_BPS) {
        for (const alpha of SWEEP_BAND_ALPHA) {
            for (const edge_bps of SWEEP_EDGE_BPS) {
                for (const amtA of SWEEP_AMOUNT_A) {
                    for (const amtB of SWEEP_AMOUNT_B) {
                        combos.push({ band_bps, alpha, edge_bps, amtA, amtB });
                    }
                }
            }
        }
    }

    console.log(`Sweeping ${combos.length} combos over ${series.length} candles…`);

    let bestFinal = -Infinity;
    let best: { params: RunParams; result: RunResult } | null = null;

    for (const p of combos) {
        const r = runBacktest(series, p);

        // Write a row
        const row = [
            TOKEN_A_Q,
            tokenB_unit,
            INTERVAL,
            series.length,
            p.band_bps,
            p.alpha,
            p.edge_bps,
            p.amtA,
            p.amtB,
            r.trades,
            r.wins,
            r.losses,
            r.winRate.toFixed(4),
            r.totalPnl.toFixed(6),
            r.medianPnl.toFixed(6),
            r.meanPnl.toFixed(6),
            (Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(4) : "Inf"),
            r.maxDD.toFixed(6),
            r.finalADA.toFixed(6),
            r.lastMid.toFixed(8),
        ].join(",") + "\n";
        fs.appendFileSync(OUT, row, "utf8");

        if (r.finalADA > bestFinal) {
            bestFinal = r.finalADA;
            best = { params: p, result: r };
        }
    }

    console.log(`Done. Results -> ${OUT}`);
    if (best) {
        const { params, result } = best;
        console.log("Best (by Final ADA):");
        console.log({
            params,
            result: {
                trades: result.trades,
                winRate: result.winRate,
                profitFactor: result.profitFactor,
                maxDrawdownADA: result.maxDD,
                finalADA: result.finalADA,
            }
        });
    }
}

main().catch(err => {
    console.error(err?.response?.data ?? err);
});

/* ---------- Notes ----------
- This sweep assumes TOKEN_A=ADA for the vs_unit=lovelace choice. If you want non-ADA bases,
  make sure your TapTools endpoint returns the right orientation or set BT_PRICE_IS_B_PER_A=true/false accordingly.

- Fees: BT_POOL_FEE_BPS and BT_AGG_FEE_BPS are applied per trade to the *output* amount
  (conservative; closer to how AMM + router fees reduce what you receive).

- The PnL formulation mirrors your live bot:
  SELL_A: pnl ≈ -amtA + (outB/mid)
  SELL_B: pnl ≈  outA - (amtB/mid)
  Equity = ADA + (B / mid)

- You can expand metrics (e.g., max consecutive losses, time-in-market) as needed.
*/
