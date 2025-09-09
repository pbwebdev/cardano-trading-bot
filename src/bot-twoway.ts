// src/bot-twoway.ts
import "dotenv/config";
import axios from "axios";
import { bech32 } from "bech32";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { Lucid, Blockfrost } from "lucid-cardano";
import { blake2b } from "blakejs";

import fs from "node:fs";
import path from "node:path";

type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;
const AGG = "https://agg-api.minswap.org/aggregator";

// Pair & sizing
const TOKEN_A_Q = (process.env.TOKEN_A ?? "ADA").trim();
const TOKEN_B_Q = (process.env.TOKEN_B ?? "MIN").trim();
const AMOUNT_A_DEC = (process.env.AMOUNT_A_DEC ?? "10").trim();   // cap for A sell (human units)
const AMOUNT_B_DEC = (process.env.AMOUNT_B_DEC ?? "100").trim();  // cap for B sell (human units)

// Numeric env helper
function num(env: string | undefined, fallback: number) {
    const n = Number(env);
    return Number.isFinite(n) ? n : fallback;
}

// Strategy
const SLIPPAGE_PCT = num(process.env.SLIPPAGE_PCT, 0.5);
const FEE_CAP_PCT  = num(process.env.FEE_CAP_PCT, 0.20);

const BAND_CENTER_ENV = process.env.BAND_CENTER;            // optional seed (TOKEN_B per TOKEN_A)
const BAND_BPS   = num(process.env.BAND_BPS, 50);           // ±bps around center
const BAND_ALPHA = num(process.env.BAND_ALPHA, 0.10);       // EMA smoothing (0..1)

const EDGE_BPS    = num(process.env.EDGE_BPS, 5);           // extra distance beyond band (bps)
const COOLDOWN_MS = num(process.env.COOLDOWN_MS, 45000);    // throttle after a fill
const POLL_MS     = num(process.env.POLL_MS, 60000);

// Decision cadence (0 disables; e.g., 14_400_000 = 4h)
const DECISION_EVERY_MS = num(process.env.DECISION_EVERY_MS, 0);

// Guards
const MIN_NOTIONAL_OUT = num(process.env.MIN_NOTIONAL_OUT, 0); // skip if out < this (human units)
const RESERVE_ADA_DEC  = num(process.env.RESERVE_ADA_DEC, 0);  // keep at least this many ADA

// Dynamic sizing controls (defaults chosen conservatively)
const MAX_PCT_A = num(process.env.MAX_PCT_A, 15);       // % of A balance per SELL_A
const MAX_PCT_B = num(process.env.MAX_PCT_B, 15);       // % of B balance per SELL_B
const MIN_TRADE_A_DEC = num(process.env.MIN_TRADE_A_DEC, 5);
const MIN_TRADE_B_DEC = num(process.env.MIN_TRADE_B_DEC, 50);

// Runtime
const DRY_RUN   = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";
const ONLY_VERI = (process.env.ONLY_VERIFIED ?? "true").toLowerCase() === "true";

// NEW: profit filter & stops (0 = disabled)
const USE_CYCLE_FILTER   = (process.env.USE_CYCLE_FILTER ?? "true").toLowerCase() === "true";
const MIN_CYCLE_PNL_BPS  = num(process.env.MIN_CYCLE_PNL_BPS, 0);   // extra beyond fees
const EST_CYCLE_FEES_BPS = num(process.env.EST_CYCLE_FEES_BPS, 60); // est round-trip fees
const TRAIL_STOP_BPS     = num(process.env.TRAIL_STOP_BPS, 0);      // trailing giveback
const HARD_STOP_BPS      = num(process.env.HARD_STOP_BPS, 0);       // from entry

// Logs
const LOG = path.join(process.cwd(), process.env.LOG ?? "fills.csv");
const CENTER_FILE = path.join(process.cwd(), process.env.CENTER_FILE ?? ".band-center.json");

// ----- persist EMA center -----
function loadCenter(): number | null {
    try { return JSON.parse(fs.readFileSync(CENTER_FILE, "utf8")).center ?? null; }
    catch { return null; }
}
function saveCenter(c: number) {
    try { fs.writeFileSync(CENTER_FILE, JSON.stringify({ center: c })); } catch {}
}

// Create CSV header if not exists (includes mid & pnl_ada)
if (!fs.existsSync(LOG)) {
    fs.writeFileSync(
        LOG,
        "ts,side,amount_in,token_in,amount_out_min,token_out,tx,mid,pnl_ada\n",
        "utf8"
    );
}

function blockfrostBase(net: Net) {
    return net === "Mainnet" ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : net === "Preprod"   ? "https://cardano-preprod.blockfrost.io/api/v0"
            :                       "https://cardano-preview.blockfrost.io/api/v0";
}

async function makeLucid() {
    const lucid = await Lucid.new(
        new Blockfrost(blockfrostBase(NETWORK), process.env.BLOCKFROST_PROJECT_ID!),
        NETWORK
    );
    await lucid.selectWalletFromPrivateKey(process.env.PRIVKEY!);
    return lucid;
}

// -------- helpers --------
function isUnit(s: string) { return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(s); }

async function resolveTokenId(query: string): Promise<string> {
    if (query.toUpperCase() === "ADA") return "lovelace";
    if (isUnit(query)) return query;
    const resp = await axios.post(`${AGG}/tokens`, { query, only_verified: ONLY_VERI });
    const items: any[] = resp.data?.tokens ?? [];
    if (!items.length) throw new Error(`Token not found: ${query}`);
    const exact = items.find(t => (t.ticker || "").toLowerCase() === query.toLowerCase());
    const chosen = exact ?? items[0];
    console.log(`Resolved ${query} => ${chosen.token_id || "lovelace"} (${chosen.ticker ?? ""})`);
    return chosen.token_id;
}

// --- decimals/meta (needed for human-sizing of token balances) ---
function isUnitLike(s: string) { return /^[0-9a-f]{56}\.[0-9a-f]+$/i.test(s); }
async function resolveTokenMeta(query: string): Promise<{ unit: string; decimals: number; ticker?: string }> {
    if (query.toUpperCase() === "ADA") return { unit: "lovelace", decimals: 6, ticker: "ADA" };
    if (isUnitLike(query)) return { unit: query, decimals: 0 };
    try {
        const resp = await axios.post(`${AGG}/tokens`, { query, only_verified: ONLY_VERI });
        const items: any[] = resp.data?.tokens ?? [];
        const chosen = items.find(t => (t.ticker || "").toLowerCase() === query.toLowerCase()) ?? items[0];
        if (!chosen) throw new Error("Token not found: " + query);
        return { unit: chosen.token_id, decimals: Number(chosen.decimals ?? 0), ticker: chosen.ticker };
    } catch {
        return { unit: query, decimals: 0 };
    }
}

function makeWitness(txCborHex: string, bech32Sk: string): string {
    const { words } = bech32.decode(bech32Sk, 2048);
    const skBytes = Buffer.from(bech32.fromWords(words));
    const sk = skBytes.length === 96
        ? CSL.PrivateKey.from_extended_bytes(skBytes)
        : CSL.PrivateKey.from_normal_bytes(skBytes);

    const tx = CSL.Transaction.from_bytes(Buffer.from(txCborHex, "hex"));
    const bodyBytes = tx.body().to_bytes();
    const hashBytes = blake2b(bodyBytes, undefined, 32);
    const txHash = CSL.TransactionHash.from_bytes(hashBytes);
    const vkeyWitness = CSL.make_vkey_witness(txHash, sk);
    const vkeys = CSL.Vkeywitnesses.new(); vkeys.add(vkeyWitness);
    const ws = CSL.TransactionWitnessSet.new(); ws.set_vkeys(vkeys);
    return Buffer.from(ws.to_bytes()).toString("hex");
}

async function getAdaBalance(lucid: Lucid) {
    const utxos = await lucid.wallet.getUtxos();
    return utxos.reduce((s, u) => s + BigInt(u.assets.lovelace ?? 0n), 0n);
}

async function getBalanceUnit(lucid: Lucid, unit: string): Promise<bigint> {
    if (unit === "lovelace") return getAdaBalance(lucid);
    const utxos = await lucid.wallet.getUtxos();
    let sum = 0n;
    for (const u of utxos) {
        const assets = u.assets as Record<string, bigint>;
        for (const [k, v] of Object.entries(assets)) {
            if (k === unit) sum += BigInt(v);
        }
    }
    return sum;
}

async function estimate(fromUnit: string, toUnit: string, amountDecimal: string) {
    const req = {
        amount: amountDecimal,
        token_in: fromUnit,
        token_out: toUnit,
        slippage: SLIPPAGE_PCT,
        allow_multi_hops: true,
        amount_in_decimal: true
    } as const;

    const res = (await axios.post(`${AGG}/estimate`, req)).data;
    const feePct = Number(res.aggregator_fee_percent ?? 0);
    if (!Number.isFinite(feePct) || feePct > FEE_CAP_PCT) {
        throw new Error(`Agg fee too high or invalid: ${res.aggregator_fee_percent}`);
    }
    return { req, res };
}

// Normalize min_amount_out to **integer** base units (string) for build-tx
function normalizeMinOut(estRes: any): string {
    const candidates = [
        estRes.min_amount_out,
        estRes.min_amount_out_units,
        estRes.min_amount_out_onchain,
        estRes.amount_out_min,
    ].filter((v) => v !== undefined && v !== null);

    if (candidates.length === 0) {
        throw new Error("estimate response missing min_amount_out");
    }

    let raw = String(candidates[0]);
    if (!raw.includes(".")) return raw; // already integer

    const decimals = Number(estRes.token_out_decimals ?? estRes.decimals_out ?? estRes.decimals ?? 0);
    const val = Number(raw);
    if (!Number.isFinite(val)) throw new Error(`min_amount_out not a number: ${raw}`);
    const scaled = Math.floor(val * Math.pow(10, decimals));
    return BigInt(scaled).toString();
}

// Convert min_amount_out (on-chain integer or decimal) to **human units** for PnL
function humanMinOut(estRes: any): number {
    if (estRes.min_amount_out_human !== undefined) return Number(estRes.min_amount_out_human);

    const raw = estRes.min_amount_out ?? estRes.min_amount_out_units ?? estRes.amount_out_min;
    if (raw === undefined || raw === null) throw new Error("estimate missing min_amount_out");

    const s = String(raw);
    if (s.includes(".")) return Number(s); // already human

    const decimals = Number(estRes.token_out_decimals ?? estRes.decimals_out ?? estRes.decimals ?? 0);
    return Number(BigInt(s)) / Math.pow(10, decimals);
}

async function executeSwap(sender: string, estReq: any, estRes: any): Promise<string> {
    const minOutFixed = normalizeMinOut(estRes);
    const build = (await axios.post(`${AGG}/build-tx`, {
        sender,
        min_amount_out: minOutFixed,
        estimate: { ...estReq, ...estRes },
    })).data;

    const unsignedCborHex: string = build.cbor;
    const witnessHex = makeWitness(unsignedCborHex, process.env.PRIVKEY!);

    const finalized = (await axios.post(`${AGG}/finalize-and-submit-tx`, {
        cbor: unsignedCborHex,
        witness_set: witnessHex,
    })).data;

    return finalized.tx_id;
}

// PnL-aware fill logger (mid = TOKEN_B per ADA at decision; pnl_ada = realized ADA)
function logFill(
    side: "SELL_A" | "SELL_B",
    amountIn: string,
    tokenIn: string,
    minOutHuman: string,     // logged in human units for readability
    tokenOut: string,
    tx: string,
    midAtFill: number,
    pnlAda: number
) {
    const row = [
        new Date().toISOString(),
        side,
        amountIn,
        tokenIn,
        minOutHuman,
        tokenOut,
        tx,
        midAtFill.toFixed(8),
        pnlAda.toFixed(6)
    ].join(",") + "\n";
    fs.appendFile(LOG, row, () => {});
}

// price derivation (numbers)
function deriveMid(quoteAtoB_minOut: number, quoteBtoA_minOut: number, amtA_dec: number, amtB_dec: number) {
    const p1 = quoteAtoB_minOut / amtA_dec;           // B per 1 A (from A->B)
    const p2 = 1 / (quoteBtoA_minOut / amtB_dec);     // B per 1 A (from B->A inverted)
    return (p1 + p2) / 2;
}

// band helpers
function bounds(center: number, bps: number) {
    return {
        lower: center * (1 - bps / 10000),
        upper: center * (1 + bps / 10000)
    };
}
function bpsOver(x: number, y: number) { return ((x - y) / y) * 10000; }

// -------- dynamic sizing helpers --------
function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
}
function fmt(n: number, dp = 6) {
    return Number.isFinite(n) ? n.toFixed(dp) : "0";
}
function splitUnit(unit: string): { policy: string; nameHex: string } {
    const [policy, nameHex] = unit.split(".");
    return { policy, nameHex };
}
async function getUtxos(lucid: Lucid) {
    return await lucid.wallet.getUtxos();
}
function sumAsset(utxos: any[], unit: string): bigint {
    if (unit === "lovelace") {
        return utxos.reduce((acc, u) => acc + BigInt(u.assets["lovelace"] ?? 0n), 0n);
    }
    const { policy, nameHex } = splitUnit(unit);
    const key = `${policy}${nameHex ? nameHex : ""}`;
    return utxos.reduce((acc, u) => acc + BigInt(u.assets[key] ?? 0n), 0n);
}
function toHumanBase(amountBase: bigint, decimals: number): number {
    if (amountBase <= 0n) return 0;
    const scale = 10 ** Math.max(0, decimals);
    return Number(amountBase) / scale;
}
async function getBalanceHuman(lucid: Lucid, unit: string, decimals: number): Promise<number> {
    const utxos = await getUtxos(lucid);
    if (unit === "lovelace") {
        const lovelace = sumAsset(utxos, "lovelace");
        return Number(lovelace) / 1_000_000;
    }
    const base = sumAsset(utxos, unit);
    return toHumanBase(base, decimals);
}

/**
 * Compute dynamic trade sizes (human decimals) for both legs.
 * - Uses % of current balances with floors/ceilings
 * - Reserves ADA so you never strand fees/staking
 * - Returns strings ready for aggregator when amount_in_decimal=true
 */
async function computeDynamicTradeSizes(
    lucid: Lucid,
    unitA: string, decA: number,
    unitB: string, decB: number,
    caps: { AMOUNT_A_DEC: number; AMOUNT_B_DEC: number }
): Promise<{ tradeA_str: string; tradeB_str: string; tradeA_num: number; tradeB_num: number }> {

    const feeBufAda = 2; // small headroom for tx fees

    const balA = await getBalanceHuman(lucid, unitA, decA);
    const balB = await getBalanceHuman(lucid, unitB, decB);

    let maxSpendA = (unitA === "lovelace")
        ? Math.max(0, balA - RESERVE_ADA_DEC - feeBufAda)
        : balA;

    const dynA = (MAX_PCT_A / 100) * maxSpendA;
    const dynB = (MAX_PCT_B / 100) * balB;

    const tradeA_num = clamp(dynA, MIN_TRADE_A_DEC, caps.AMOUNT_A_DEC);
    const tradeB_num = clamp(dynB, MIN_TRADE_B_DEC, caps.AMOUNT_B_DEC);

    const tradeA_str = fmt(tradeA_num, Math.min(6, decA || 6));
    const tradeB_str = fmt(tradeB_num, Math.min(6, decB || 6));

    return { tradeA_str, tradeB_str, tradeA_num, tradeB_num };
}

/* ---------- position memory (cycle filter + trailing/hard stops) ---------- */
type PosMode = "LONG_A" | "LONG_B" | null; // LONG_B means last SELL_A (holding B), LONG_A means last SELL_B
let posMode: PosMode = null;
let entryMid = 0;     // mid at entry
let peakMid  = 0;     // best favorable mid since entry
let troughMid = 0;    // best favorable mid for LONG_A (down-move)

function favorableMoveBps(midNow: number) {
    if (posMode === "LONG_B") return ((midNow - entryMid) / entryMid) * 10000; // up is good
    if (posMode === "LONG_A") return ((entryMid - midNow) / entryMid) * 10000; // down is good
    return 0;
}
function trailDrawdownBps(midNow: number) {
    if (posMode === "LONG_B" && peakMid > 0) return ((peakMid - midNow) / peakMid) * 10000;
    if (posMode === "LONG_A" && troughMid > 0) return ((midNow - troughMid) / troughMid) * 10000;
    return 0;
}
function hardStopFromEntryBps(midNow: number) {
    if (posMode === "LONG_B") return ((entryMid - midNow) / entryMid) * 10000; // down is bad
    if (posMode === "LONG_A") return ((midNow - entryMid) / entryMid) * 10000; // up is bad
    return 0;
}
function openPos(newMode: PosMode, midNow: number) {
    posMode = newMode;
    entryMid = peakMid = troughMid = midNow;
}
function closePos() {
    posMode = null; entryMid = peakMid = troughMid = 0;
}

let centerGlobal: number | null = null;  // for SIGINT persistence

async function main() {
    const lucid = await makeLucid();
    const sender = await lucid.wallet.address();

    // Resolve token units & decimals
    const unitA = await resolveTokenId(TOKEN_A_Q);
    const unitB = await resolveTokenId(TOKEN_B_Q);
    const metaA = await resolveTokenMeta(TOKEN_A_Q);
    const metaB = await resolveTokenMeta(TOKEN_B_Q);
    const decA = metaA.decimals ?? (unitA === "lovelace" ? 6 : 0);
    const decB = metaB.decimals ?? (unitB === "lovelace" ? 6 : 0);

    console.log(`PAIR: ${TOKEN_A_Q} (${unitA}, d=${decA}) ⇄ ${TOKEN_B_Q} (${unitB}, d=${decB})`);
    console.log(`Poll=${POLL_MS}ms | slippage=${SLIPPAGE_PCT}% | feeCap=${FEE_CAP_PCT}% | dryRun=${DRY_RUN} | EMA alpha=${BAND_ALPHA} | band±${BAND_BPS}bps | edge=${EDGE_BPS}bps`);

    // fees buffer
    const ada = await getAdaBalance(lucid);
    if (ada < 2_000_000n) throw new Error(`Need ~2 ADA for fees. Have ${ada} lovelace.`);

    // EMA-centered band
    let center =
        Number.isFinite(Number(BAND_CENTER_ENV)) && Number(BAND_CENTER_ENV) > 0
            ? Number(BAND_CENTER_ENV)
            : (loadCenter() ?? NaN);
    centerGlobal = Number.isFinite(center) ? center : null;

    let lastTradeAt = 0;

    // Decision cadence state
    let nextDecisionAt = 0;
    function alignNextDecision(nowMs: number) {
        if (DECISION_EVERY_MS <= 0) return;
        const bucket = Math.floor(nowMs / DECISION_EVERY_MS) + 1;
        nextDecisionAt = bucket * DECISION_EVERY_MS;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const now = Date.now();
            if (DECISION_EVERY_MS > 0 && nextDecisionAt === 0) {
                alignNextDecision(now); // first alignment on startup
            }

            const capA = Number(AMOUNT_A_DEC);
            const capB = Number(AMOUNT_B_DEC);

            // 1) Quotes both ways (using caps) to compute mid & guards
            const [{ res: resAB_caps }, { res: resBA_caps }] = await Promise.all([
                estimate(unitA, unitB, AMOUNT_A_DEC),
                estimate(unitB, unitA, AMOUNT_B_DEC),
            ]);

            const minOutAB = Number(resAB_caps.min_amount_out);
            const minOutBA = Number(resBA_caps.min_amount_out);
            if (!Number.isFinite(minOutAB) || !Number.isFinite(minOutBA)) {
                throw new Error(`Bad min_amount_out: A->B=${resAB_caps.min_amount_out} B->A=${resBA_caps.min_amount_out}`);
            }

            // Optional notional guard (in token_out human units)
            const smallAB = MIN_NOTIONAL_OUT > 0 && minOutAB < MIN_NOTIONAL_OUT;
            const smallBA = MIN_NOTIONAL_OUT > 0 && minOutBA < MIN_NOTIONAL_OUT;
            if (smallAB) console.log(`[guard] A->B min_out ${minOutAB} < ${MIN_NOTIONAL_OUT} — holding`);
            if (smallBA) console.log(`[guard] B->A min_out ${minOutBA} < ${MIN_NOTIONAL_OUT} — holding`);

            // 2) Mid price (TOKEN_B per TOKEN_A) using caps for stability
            const mid = deriveMid(minOutAB, minOutBA, capA, capB);

            // 3) EMA center update
            if (!Number.isFinite(center)) {
                center = mid;
                console.log(`[init] band center set to first mid: ${center.toFixed(8)} ${TOKEN_B_Q}/${TOKEN_A_Q}`);
            } else {
                center = BAND_ALPHA * mid + (1 - BAND_ALPHA) * center;
                saveCenter(center);
            }
            centerGlobal = center;

            const { lower, upper } = bounds(center, BAND_BPS);
            console.log(
                `[tick] mid≈ ${mid.toFixed(8)} ${TOKEN_B_Q}/${TOKEN_A_Q} | band [${lower.toFixed(8)}, ${upper.toFixed(8)}] | center≈ ${center.toFixed(8)}`
            );

            // Update trailing extremes for open position
            if (posMode) {
                peakMid   = Math.max(peakMid || mid, mid);
                troughMid = Math.min(troughMid || mid, mid);
            }

            // 4) Decide action from band/edge
            let action: "SELL_A" | "SELL_B" | "HOLD" = "HOLD";
            const overUpperBps = bpsOver(mid, upper);
            const underLowerBps = bpsOver(lower, mid);
            if (mid > upper && overUpperBps >= EDGE_BPS) action = "SELL_A";
            else if (mid < lower && underLowerBps >= EDGE_BPS) action = "SELL_B";

            // Decision cadence gate – only act when the window opens
            if (DECISION_EVERY_MS > 0 && now < nextDecisionAt) {
                await new Promise((r) => setTimeout(r, POLL_MS));
                continue;
            }

            // --- optional forced close via trailing/hard stop (pre-empts band) ---
            let forcedClose: "SELL_A" | "SELL_B" | null = null;
            if (posMode) {
                const tdBps = TRAIL_STOP_BPS > 0 ? trailDrawdownBps(mid) : -1;
                const hsBps = HARD_STOP_BPS  > 0 ? hardStopFromEntryBps(mid) : -1;
                if ((TRAIL_STOP_BPS > 0 && tdBps >= TRAIL_STOP_BPS) || (HARD_STOP_BPS > 0 && hsBps >= HARD_STOP_BPS)) {
                    forcedClose = posMode === "LONG_B" ? "SELL_B" : "SELL_A";
                }
            }

            // Compose planned action
            let planned: "SELL_A" | "SELL_B" | "HOLD" = forcedClose ?? action;

            // Disallow adding to same side while a position is open (single-position policy)
            if (posMode === "LONG_B" && planned === "SELL_A") planned = "HOLD";
            if (posMode === "LONG_A" && planned === "SELL_B") planned = "HOLD";

            // Profit filter when attempting to close a cycle
            if (USE_CYCLE_FILTER && posMode && (
                (posMode === "LONG_B" && planned === "SELL_B") ||
                (posMode === "LONG_A" && planned === "SELL_A")
            )) {
                const need = MIN_CYCLE_PNL_BPS + EST_CYCLE_FEES_BPS;
                if (favorableMoveBps(mid) < need && !forcedClose) {
                    planned = "HOLD";
                }
            }

            // Existing notional guards
            if (planned === "HOLD" || (planned === "SELL_A" && smallAB) || (planned === "SELL_B" && smallBA)) {
                await new Promise((r) => setTimeout(r, POLL_MS));
                continue;
            }

            // 5) Cooldown (show remaining time)
            if (!DRY_RUN) {
                const delta = Date.now() - lastTradeAt;
                const remain = COOLDOWN_MS - delta;
                if (remain > 0) {
                    console.log(`[cooldown] ${Math.max(0, remain)}ms remaining`);
                    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remain)));
                    continue;
                }
            }

            // 6) Compute dynamic sizes off live balances (floors/ceilings/reserve)
            const { tradeA_str, tradeB_str, tradeA_num, tradeB_num } =
                await computeDynamicTradeSizes(lucid, unitA, decA, unitB, decB, { AMOUNT_A_DEC: Number(AMOUNT_A_DEC), AMOUNT_B_DEC: Number(AMOUNT_B_DEC) });

            if (tradeA_num <= 0 && tradeB_num <= 0) {
                console.log("[sizing] no available size (after reserve/floors) — holding");
                await new Promise((r) => setTimeout(r, POLL_MS));
                continue;
            }

            // 7) Re-estimate for the chosen side using the dynamic size, then execute
            if (planned === "SELL_A") {
                // ADA reserve guard if A is ADA (uses dynamic size)
                if (unitA === "lovelace") {
                    const buf = 2_000_000n; // fee buffer
                    const adaBal = await getAdaBalance(lucid);
                    const sellAdaLovelace = BigInt(Math.round(tradeA_num * 1_000_000));
                    const reserveLovelace  = BigInt(Math.round(RESERVE_ADA_DEC * 1_000_000));

                    if (adaBal - sellAdaLovelace < reserveLovelace + buf) {
                        console.log(`[guard] reserve: keep ≥ ${RESERVE_ADA_DEC} ADA + fees; holding`);
                        await new Promise((r) => setTimeout(r, POLL_MS));
                        continue;
                    }
                    if (adaBal < sellAdaLovelace + buf) {
                        console.warn("Not enough ADA to sell A");
                        await new Promise((r) => setTimeout(r, POLL_MS));
                        continue;
                    }
                } else {
                    const balA = await getBalanceUnit(lucid, unitA);
                    if (balA <= 0n) {
                        console.warn("No TOKEN_A balance");
                        await new Promise((r) => setTimeout(r, POLL_MS));
                        continue;
                    }
                }

                // Re-estimate with dynamic amount
                const { req: reqAB, res: resAB } = await estimate(unitA, unitB, tradeA_str);
                console.log(`ACTION: SELL_A ${tradeA_str} ${TOKEN_A_Q} → ${TOKEN_B_Q} (edge+${overUpperBps.toFixed(2)}bps)`);

                if (DRY_RUN) {
                    console.log("[dry-run] skipping trade");
                } else {
                    const tx = await executeSwap(sender, reqAB, resAB);
                    console.log("Submitted:", tx);

                    // PnL in ADA at decision mid:
                    // Received B (human) -> ADA value ≈ B / mid; minus ADA spent
                    const minOutB_human = humanMinOut(resAB);
                    const pnlADA = (minOutB_human / mid) - tradeA_num;

                    console.log(`PnL (SELL_A): ${pnlADA.toFixed(6)} ADA @ mid ${mid.toFixed(8)}`);
                    logFill("SELL_A", tradeA_str, TOKEN_A_Q, String(minOutB_human), TOKEN_B_Q, tx, mid, pnlADA);

                    lastTradeAt = Date.now();
                    if (DECISION_EVERY_MS > 0) alignNextDecision(lastTradeAt);

                    // Position updates
                    if (posMode === "LONG_A") closePos();
                    if (posMode === null) openPos("LONG_B", mid);
                }
            } else if (planned === "SELL_B") {
                if (unitB === "lovelace") {
                    const buf = 2_000_000n;
                    const required = BigInt(Math.round(tradeB_num * 1_000_000)) + buf;
                    const adaBal = await getAdaBalance(lucid);
                    if (adaBal < required) {
                        console.warn("Not enough ADA to sell B");
                        await new Promise((r) => setTimeout(r, POLL_MS));
                        continue;
                    }
                } else {
                    const balB = await getBalanceUnit(lucid, unitB);
                    if (balB <= 0n) {
                        console.warn("No TOKEN_B balance");
                        await new Promise((r) => setTimeout(r, POLL_MS));
                        continue;
                    }
                }

                // Re-estimate with dynamic amount
                const { req: reqBA, res: resBA } = await estimate(unitB, unitA, tradeB_str);
                console.log(`ACTION: SELL_B ${tradeB_str} ${TOKEN_B_Q} → ${TOKEN_A_Q} (edge+${underLowerBps.toFixed(2)}bps)`);

                if (DRY_RUN) {
                    console.log("[dry-run] skipping trade");
                } else {
                    const tx = await executeSwap(sender, reqBA, resBA);
                    console.log("Submitted:", tx);

                    // PnL in ADA at decision mid:
                    // Received ADA (human) minus ADA-equivalent of B sold
                    const minOutA_human = humanMinOut(resBA);
                    const pnlADA = minOutA_human - (tradeB_num / mid);

                    console.log(`PnL (SELL_B): ${pnlADA.toFixed(6)} ADA @ mid ${mid.toFixed(8)}`);
                    logFill("SELL_B", tradeB_str, TOKEN_B_Q, String(minOutA_human), TOKEN_A_Q, tx, mid, pnlADA);

                    lastTradeAt = Date.now();
                    if (DECISION_EVERY_MS > 0) alignNextDecision(lastTradeAt);

                    // Position updates
                    if (posMode === "LONG_B") closePos();
                    if (posMode === null) openPos("LONG_A", mid);
                }
            }

            await new Promise((r) => setTimeout(r, POLL_MS));
        } catch (e: any) {
            if (axios.isAxiosError(e)) {
                console.error("HTTP", e.response?.status, e.response?.data ?? e.message);
            } else {
                console.error(e?.message ?? e);
            }
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
    }
}

process.on("SIGINT", () => {
    try { if (Number.isFinite(centerGlobal!)) saveCenter(centerGlobal as number); } catch {}
    console.log("\nBye! Saved band center.");
    process.exit(0);
});

main().catch(console.error);
