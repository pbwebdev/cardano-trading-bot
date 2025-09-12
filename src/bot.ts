// --- filepath: src/bot.ts ---
import { loadConfig, loadCenter, saveCenter } from "./config.js";
import { log } from "./util/logger.js";
import { getMidPrice, resolvePairVerbose } from "./clients/minswapAgg.js";
import { nextEma, bandFromCenter, shouldTrade } from "./strategy/emaBand.js";
import { appendFillCsv } from "./persistence/state.js";
import { simulateOrExecute } from "./execution/executor.js";
import { initLucid } from "./wallet.js";
import { fetchWalletBalances } from "./clients/walletInfo.js";
import { sizeWithCaps, applyAdaReserve, passesMinTrade } from "./risk.js";

type Candle = {
    start: number;
    end: number;
    o: number;
    h: number;
    l: number;
    c: number;
};

export async function runBot() {
    const cfg = loadConfig();

    // Resolve & log token IDs + metadata once
    const pair = await resolvePairVerbose(cfg, cfg.TOKEN_A, cfg.TOKEN_B);
    log.info(
        "[pair] A:",
        cfg.TOKEN_A,
        "→",
        pair.a.token_id,
        metaStr(pair.a),
        "| B:",
        cfg.TOKEN_B,
        "→",
        pair.b.token_id,
        metaStr(pair.b)
    );

    // Ensure we have an address (either from env or from privkey)
    let senderAddress = cfg.ADDRESS;
    if (!senderAddress && cfg.PRIVKEY) {
        const { address } = await initLucid(cfg);
        senderAddress = address;
    }

    // Cadence
    const decisionEvery = cfg.DECISION_EVERY_MS > 0 ? cfg.DECISION_EVERY_MS : 0;
    const candleMs =
        (cfg.CANDLE_MS > 0 ? cfg.CANDLE_MS : 0) ||
        (decisionEvery > 0 ? decisionEvery : 0); // default: tie candles to decision cadence when provided
    log.info("[cadence]", {
        candleMs,
        decisionEvery,
        pollMs: cfg.POLL_MS,
        cooldownMs: cfg.COOLDOWN_MS,
        candleH: candleMs ? (candleMs / 3_600_000).toFixed(2) : "0",
        decisionH: decisionEvery ? (decisionEvery / 3_600_000).toFixed(2) : "0",
    });

    // State
    let band = loadCenter(cfg.CENTER_FILE);
    let center = band?.center ?? null;

    let coolingUntil = 0;
    let nextDecisionAt = decisionEvery > 0 ? alignForward(Date.now(), decisionEvery) : 0;

    let candle: Candle | null = null;
    let lastClosedClose: number | null = null;

    while (true) {
        try {
            const now = Date.now();
            const mid = await getMidPrice(cfg, cfg.TOKEN_A, cfg.TOKEN_B); // B per A

            // Candle maintenance
            if (candleMs > 0) {
                candle = rollCandle(candle, now, mid, candleMs, (closed) => {
                    lastClosedClose = closed.c;
                    // Update EMA center **on candle close** (use close price)
                    center = nextEma(center ?? null, closed.c, cfg.BAND_ALPHA);
                    saveCenter(cfg.CENTER_FILE, center!);
                    log.info(
                        "[candle]",
                        new Date(closed.start).toISOString(),
                        "→",
                        new Date(closed.end).toISOString(),
                        { o: closed.o, h: closed.h, l: closed.l, c: closed.c, center }
                    );
                });
            } else {
                // No candle mode → update EMA on every tick
                center = nextEma(center ?? null, mid, cfg.BAND_ALPHA);
                saveCenter(cfg.CENTER_FILE, center!);
            }

            const useCenter = center ?? mid;
            const { lo, hi } = bandFromCenter(useCenter, cfg.BAND_BPS);

            log.tick(
                `mid≈ ${mid.toFixed(8)} ${cfg.TOKEN_B}/${cfg.TOKEN_A} | band [${lo.toFixed(8)}, ${hi.toFixed(8)}] | center≈ ${useCenter.toFixed(8)}`
            );

            // persist on first center or material move
            if (!band || Math.abs(useCenter - (band.center ?? 0)) / useCenter > 0.0001) {
                saveCenter(cfg.CENTER_FILE, useCenter);
                band = { center: useCenter, updatedAt: now };
            }

            // Cooldown gate
            if (now < coolingUntil) {
                await sleep(cfg.POLL_MS);
                continue;
            }

            // Balance read (if address provided)
            let adaBal = 0;
            let aBal = Number.POSITIVE_INFINITY;
            let bBal = Number.POSITIVE_INFINITY;
            if (senderAddress) {
                const wb = await fetchWalletBalances(cfg, senderAddress);
                adaBal = wb.adaDec;
                aBal = pair.a.token_id === "lovelace" ? wb.adaDec : (wb.tokens[pair.a.token_id]?.amountDec ?? 0);
                bBal = pair.b.token_id === "lovelace" ? wb.adaDec : (wb.tokens[pair.b.token_id]?.amountDec ?? 0);
            }

            // Decision gate
            const isDecisionTick =
                decisionEvery === 0 ? true : now >= nextDecisionAt;

            if (!isDecisionTick) {
                await sleep(cfg.POLL_MS);
                continue;
            }
            if (decisionEvery > 0) {
                // align next decision to cadence
                nextDecisionAt = alignForward(nextDecisionAt, decisionEvery);
            }

            // Choose the price to evaluate at:
            // - In candle mode → use the last *closed* candle close if available; else skip the first decision
            // - Otherwise → use current mid
            const decisionPrice =
                candleMs > 0 ? lastClosedClose ?? null : mid;

            if (candleMs > 0 && decisionPrice == null) {
                // Wait until we have the first closed candle
                await sleep(cfg.POLL_MS);
                continue;
            }

            const price = (decisionPrice ?? mid) as number;
            const { buy, sell } = shouldTrade(price, useCenter, cfg.EDGE_BPS);

            if (buy) {
                let inAmountDec = sizeWithCaps(cfg, "BUY_B", { ada: adaBal, a: aBal, b: bBal }, cfg.AMOUNT_A_DEC);
                if (pair.a.token_id === "lovelace") {
                    inAmountDec = applyAdaReserve(inAmountDec, adaBal, cfg.RESERVE_ADA_DEC);
                }
                if (passesMinTrade(cfg, "BUY_B", inAmountDec) && inAmountDec > 0) {
                    await simulateOrExecute(cfg, "BUY_B", cfg.TOKEN_A, cfg.TOKEN_B, inAmountDec, senderAddress);
                    appendFillCsv(cfg.LOG, {
                        ts: new Date().toISOString(),
                        side: "BUY_B",
                        price,
                        inAmountDec,
                        outAmountDec: 0,
                        center: useCenter,
                        bandLo: lo,
                        bandHi: hi,
                    });
                    coolingUntil = now + cfg.COOLDOWN_MS;
                }
            } else if (sell) {
                const wanted = cfg.AMOUNT_B_DEC;
                const inAmountDec = sizeWithCaps(cfg, "SELL_B", { ada: adaBal, a: aBal, b: bBal }, wanted);
                if (passesMinTrade(cfg, "SELL_B", inAmountDec) && inAmountDec > 0) {
                    await simulateOrExecute(cfg, "SELL_B", cfg.TOKEN_B, cfg.TOKEN_A, inAmountDec, senderAddress);
                    appendFillCsv(cfg.LOG, {
                        ts: new Date().toISOString(),
                        side: "SELL_B",
                        price,
                        inAmountDec,
                        outAmountDec: 0,
                        center: useCenter,
                        bandLo: lo,
                        bandHi: hi,
                    });
                    coolingUntil = now + cfg.COOLDOWN_MS;
                }
            }

            await sleep(cfg.POLL_MS);
        } catch (e: any) {
            const status = e?.response?.status;
            const data = e?.response?.data;
            if (status) log.error(`[http ${status}]`, typeof data === "string" ? data : JSON.stringify(data));
            else log.error(e?.message || e);
            await sleep(5000);
        }
    }
}

function rollCandle(
    cur: Candle | null,
    now: number,
    price: number,
    candleMs: number,
    onClose: (c: Candle) => void
): Candle {
    // initialize aligned to boundary
    if (!cur) {
        const start = Math.floor(now / candleMs) * candleMs;
        return { start, end: start + candleMs, o: price, h: price, l: price, c: price };
    }

    // close and roll forward if elapsed
    while (now >= cur.end) {
        const closed: Candle = cur;              // <-- annotate the closed candle
        onClose(closed);
        const nextStart: number = closed.end;    // <-- explicit type fixes TS7022
        cur = { start: nextStart, end: nextStart + candleMs, o: price, h: price, l: price, c: price };
    }

    // update current candle
    cur.h = Math.max(cur.h, price);
    cur.l = Math.min(cur.l, price);
    cur.c = price;
    return cur;
}

function alignForward(t: number, step: number): number {
    return t + step;
}

function metaStr(i: { ticker?: string; project_name?: string; decimals?: number; is_verified?: boolean }) {
    const bits: string[] = [];
    if (i.ticker) bits.push(`ticker=${i.ticker}`);
    if (i.project_name) bits.push(`name=${i.project_name}`);
    if (typeof i.decimals === "number") bits.push(`dec=${i.decimals}`);
    if (typeof i.is_verified === "boolean") bits.push(`verified=${i.is_verified}`);
    return bits.length ? `(${bits.join(", ")})` : "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
