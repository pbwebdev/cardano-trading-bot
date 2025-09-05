// src/backtest-taptools.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

/**
 * Backtest your EMA-band strategy using TapTools historical candles.
 * Now supports TOKEN_B as a symbol (e.g., USDM/USDA) by resolving via
 * Minswap Aggregator /tokens to a verified on-chain unit.
 *
 * Output:
 *  - Console summary in ADA terms (goal: grow ADA)
 *  - CSV "backtest_trades.csv" with every simulated fill
 */

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;

// ---------- Pair ----------
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim(); // "ADA" or token unit
const TOKEN_B_Q = (process.env.TOKEN_B ?? "USDM").trim(); // symbol (USDM/USDA/MIN) or unit

// ---------- Strategy ----------
const BAND_BPS   = num(process.env.BAND_BPS,   50);   // ±bps around EMA center
const BAND_ALPHA = num(process.env.BAND_ALPHA, 0.10); // EMA smoothing (0..1)
const EDGE_BPS   = num(process.env.EDGE_BPS,   5);    // must exceed band by this much

// Trade sizing (human units)
const AMOUNT_A_DEC = num(process.env.AMOUNT_A_DEC, 10);   // sell A size
const AMOUNT_B_DEC = num(process.env.AMOUNT_B_DEC, 100);  // sell B size

// Start balances (human units)
let invADA  = num(process.env.BT_START_ADA,  100);
let invTOKB = num(process.env.BT_START_TOKB, 0);

// Candle request
const INTERVAL     = (process.env.BT_INTERVAL ?? "1h").trim();  // 1m/5m/1h/4h/1d...
const MAX_CANDLES  = num(process.env.BT_MAX_POINTS, 3000);
const START_EPOCH  = num(process.env.BT_START_EPOCH, 0); // ms epoch
const END_EPOCH    = num(process.env.BT_END_EPOCH,   0); // ms epoch

// Fees (you can tune these to mimic routing costs)
const POOL_FEE_BPS      = num(process.env.BT_POOL_FEE_BPS, 30); // e.g., 0.30%
const EXTRA_AGG_FEE_BPS = num(process.env.BT_AGG_FEE_BPS,  0);

// TapTools
const TAP_BASE = (process.env.TAPTOOLS_BASE ?? "https://openapi.taptools.io").trim();
const TAP_KEY  = process.env.TAPTOOLS_API_KEY!; // set this in your .env

// Minswap Aggregator (used to resolve symbol -> on-chain unit)
const AGG = "https://agg-api.minswap.org/aggregator";
const ONLY_VERI = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true"; // default true for backtest

// Price orientation flag (if your TapTools series is ADA per B, flip it)
const PRICE_IS_B_PER_A = (process.env.BT_PRICE_IS_B_PER_A ?? "true").toLowerCase() === "true";

// Output CSV
const OUT = path.join(process.cwd(), "backtest_trades.csv");
if (!fs.existsSync(OUT)) {
    fs.writeFileSync(
        OUT,
        "ts,side,mid,center,lower,upper,amount_in,token_in,amount_out,token_out,fee_bps\n",
        "utf8"
    );
}

/* =========================
   Helpers
   ========================= */
function num(env: string | undefined, fallback: number) {
    const n = Number(env);
    return Number.isFinite(n) ? n : fallback;
}

function isUnitPolicyDotAsset(s: string) {
    // policyId is 28 bytes => 56 hex chars; assetNameHex is 1+ hex chars
    return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(s);
}

function bpsOver(x: number, y: number) { return ((x - y) / y) * 10000; }

function bounds(center: number, bps: number) {
    return { lower: center * (1 - bps / 10000), upper: center * (1 + bps / 10000) };
}

function applyFeesOut(amountOut: number, totalFeeBps: number) {
    return amountOut * (1 - totalFeeBps / 10000);
}

// Resolve TOKEN_B symbol (e.g., USDM/USDA/MIN) to on-chain unit via Minswap Aggregator
async function resolveUnitViaAggregator(query: string): Promise<string> {
    if (query.toUpperCase() === "ADA") return "lovelace";
    if (isUnitPolicyDotAsset(query)) return query;

    // Prefer verified results and exact ticker match; fallback to first
    const payload = { query, only_verified: ONLY_VERI };
    const resp = await axios.post(`${AGG}/tokens`, payload);
    const items: any[] = resp.data?.tokens ?? [];

    if (!items.length) {
        throw new Error(`Could not resolve "${query}" via Minswap aggregator /tokens`);
    }

    // 1) try exact ticker match (case-insensitive) among verified if ONLY_VERI
    const exactVerified =
        items.find(t => (t.verified === true) && (t.ticker || "").toLowerCase() === query.toLowerCase());
    if (exactVerified?.token_id) return exactVerified.token_id;

    // 2) any exact ticker match
    const exactAny =
        items.find(t => (t.ticker || "").toLowerCase() === query.toLowerCase());
    if (exactAny?.token_id) return exactAny.token_id;

    // 3) otherwise pick the first verified item
    const firstVerified = items.find(t => t.verified === true);
    if (firstVerified?.token_id) return firstVerified.token_id;

    // 4) fallback to the first item
    return items[0].token_id;
}

/** Candle shape (we expect close as the main price) */
type Candle = { ts: number; open: number; high: number; low: number; close: number; volume?: number };

/* =========================
   TapTools fetch
   ========================= */
async function fetchCandlesTapTools(params: {
    tokenA_unit_or_symbol: string; // "lovelace" or policy.asset (we’ll pass through)
    tokenB_unit: string;           // policy.asset for B (resolved via AGG)
    interval: string;              // "1m" | "5m" | "1h" | "4h" | "1d"
    limit: number;
    start?: number;                // ms epoch (optional)
    end?: number;                  // ms epoch (optional)
}): Promise<Candle[]> {
    // Common path (varies by plan)
    const PATH = "/api/v1/token/ohlcv";

    // We’ll request candles for tokenB’s unit; TapTools often wants `unit` or `onchainID`.
    const unit = params.tokenB_unit;

    // If the endpoint supports quote selection, we attempt to pass ADA as vs_unit (lovelace).
    // If TapTools ignores it, we’ll interpret series via PRICE_IS_B_PER_A flag later.
    const vs_unit = params.tokenA_unit_or_symbol.toUpperCase() === "ADA" ? "lovelace" : params.tokenA_unit_or_symbol;

    const q: Record<string, any> = {
        unit,
        onchainID: unit,        // some plans prefer this name — sending both is harmless
        vs_unit,                // attempt to quote vs ADA (lovelace); API may ignore
        interval: params.interval,
        limit: params.limit,
    };
    if (params.start && params.start > 0) q.start = Math.floor(params.start / 1000);
    if (params.end && params.end > 0)     q.end   = Math.floor(params.end   / 1000);

    const url = `${TAP_BASE}${PATH}`;

    try {
        const resp = await axios.get(url, {
            headers: {
                "x-api-key": TAP_KEY,
                accept: "application/json",
            },
            params: q,
        });

        const raw = resp.data?.data ?? resp.data;
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error("No candle data returned from TapTools (check unit/interval/time window).");
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
        // helpful debugging
        console.error("TapTools request failed", {
            url,
            params: q,
            status: e?.response?.status,
            data: e?.response?.data,
        });
        throw e;
    }
}

/* =========================
   Backtest
   ========================= */
async function main() {
    // Resolve units compatible with both live trading & backtesting:
    // - TOKEN_A: "ADA" -> lovelace (we still treat A as ADA for PnL)
    // - TOKEN_B: symbol (USDM/USDA/MIN/etc.) -> resolve via AGG to policy.asset
    const unitA = TOKEN_A_Q.toUpperCase() === "ADA" ? "lovelace" : TOKEN_A_Q;
    const unitB = await resolveUnitViaAggregator(TOKEN_B_Q);

    console.log(`Backtest pair: A=${TOKEN_A_Q} (${unitA})  B=${TOKEN_B_Q} -> ${unitB}`);

    const candles = await fetchCandlesTapTools({
        tokenA_unit_or_symbol: TOKEN_A_Q, // hint we want ADA quote (lovelace)
        tokenB_unit: unitB,               // resolved policy.asset for B
        interval: INTERVAL,
        limit: MAX_CANDLES,
        start: START_EPOCH || undefined,
        end: END_EPOCH || undefined,
    });

    if (!candles.length) throw new Error("No candles returned. Check path/params/auth for TapTools.");

    // Build mid series (B per A) from closes. If your series is A per B, flip with flag.
    const series = candles
        .map(c => ({ t: c.ts, mid: Number(c.close) }))
        .filter(p => Number.isFinite(p.mid))
        .sort((a, b) => a.t - b.t);

    if (!PRICE_IS_B_PER_A) {
        for (const p of series) p.mid = 1 / p.mid; // flip to B per A
    }

    // Run strategy
    let center = series[0].mid; // seed EMA
    const trades: Array<{ ts:number, side:"SELL_A"|"SELL_B", mid:number, amountIn:number, amountOut:number, feeBps:number }> = [];

    for (const { t, mid } of series) {
        // EMA update
        center = BAND_ALPHA * mid + (1 - BAND_ALPHA) * center;
        const { lower, upper } = bounds(center, BAND_BPS);

        let action: "HOLD" | "SELL_A" | "SELL_B" = "HOLD";
        const overUpper = bpsOver(mid, upper);
        const underLower = bpsOver(lower, mid);
        if (mid > upper && overUpper >= EDGE_BPS) action = "SELL_A";      // sell A -> get B
        else if (mid < lower && underLower >= EDGE_BPS) action = "SELL_B"; // sell B -> get A

        if (action === "HOLD") continue;

        const totalFeeBps = POOL_FEE_BPS + EXTRA_AGG_FEE_BPS;

        if (action === "SELL_A") {
            if (invADA < AMOUNT_A_DEC) continue;
            const rawOutB = mid * AMOUNT_A_DEC;             // B per A * A size
            const outB    = applyFeesOut(rawOutB, totalFeeBps);
            invADA  -= AMOUNT_A_DEC;
            invTOKB += outB;

            trades.push({ ts: t, side: "SELL_A", mid, amountIn: AMOUNT_A_DEC, amountOut: outB, feeBps: totalFeeBps });
            fs.appendFileSync(OUT, `${new Date(t).toISOString()},SELL_A,${mid},${center},${lower},${upper},${AMOUNT_A_DEC},${TOKEN_A_Q},${outB},${TOKEN_B_Q},${totalFeeBps}\n`);
        } else {
            if (invTOKB < AMOUNT_B_DEC) continue;
            const rawOutA = AMOUNT_B_DEC / mid;             // A per B
            const outA    = applyFeesOut(rawOutA, totalFeeBps);
            invTOKB -= AMOUNT_B_DEC;
            invADA  += outA;

            trades.push({ ts: t, side: "SELL_B", mid, amountIn: AMOUNT_B_DEC, amountOut: outA, feeBps: totalFeeBps });
            fs.appendFileSync(OUT, `${new Date(t).toISOString()},SELL_B,${mid},${center},${lower},${upper},${AMOUNT_B_DEC},${TOKEN_B_Q},${outA},${TOKEN_A_Q},${totalFeeBps}\n`);
        }
    }

    // Mark remaining B to ADA at the last mid
    const lastMid = series[series.length - 1].mid;
    const adaFromB = invTOKB / lastMid;
    const endADA = invADA + adaFromB;

    console.log(`Candles: ${series.length} | Trades: ${trades.length}`);
    console.log(`End Balances → ADA=${invADA.toFixed(6)} ; ${TOKEN_B_Q}=${invTOKB.toFixed(6)} ; Marked ADA=${endADA.toFixed(6)} (mid=${lastMid.toFixed(8)})`);
    console.log(`CSV: ${OUT}`);
}

main().catch(err => {
    console.error(err?.response?.data ?? err);
});
