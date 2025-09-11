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

export async function runBot() {
    const cfg = loadConfig();

    // Resolve & log token IDs + metadata once
    const pair = await resolvePairVerbose(cfg, cfg.TOKEN_A, cfg.TOKEN_B);
    log.info("[pair] A:", cfg.TOKEN_A, "→", pair.a.token_id, metaStr(pair.a), "| B:", cfg.TOKEN_B, "→", pair.b.token_id, metaStr(pair.b));

    // Ensure we have an address (either from env or from privkey)
    let senderAddress = cfg.ADDRESS;
    if (!senderAddress && cfg.PRIVKEY) {
        const { address } = await initLucid(cfg);
        senderAddress = address;
    }

    let band = loadCenter(cfg.CENTER_FILE);
    let coolingUntil = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const now = Date.now();
            const mid = await getMidPrice(cfg, cfg.TOKEN_A, cfg.TOKEN_B); // B per A
            const center = nextEma(band?.center ?? null, mid, cfg.BAND_ALPHA);
            const { lo, hi } = bandFromCenter(center, cfg.BAND_BPS);
            const { buy, sell } = shouldTrade(mid, center, cfg.EDGE_BPS);

            log.tick(`mid≈ ${mid.toFixed(8)} ${cfg.TOKEN_B}/${cfg.TOKEN_A} | band [${lo.toFixed(8)}, ${hi.toFixed(8)}] | center≈ ${center.toFixed(8)}`);

            // persist center periodically
            if (!band || Math.abs(center - (band.center ?? 0)) / center > 0.0001) {
                saveCenter(cfg.CENTER_FILE, center);
                band = { center, updatedAt: now };
            }

            if (now < coolingUntil) {
                await sleep(cfg.POLL_MS);
                continue;
            }

            // Read balances if we have an address; otherwise fall back to configured amounts
            let adaBal = 0;
            let aBal = Number.POSITIVE_INFINITY; // if no address, don't cap by balance
            let bBal = Number.POSITIVE_INFINITY;
            if (senderAddress) {
                const wb = await fetchWalletBalances(cfg, senderAddress);
                adaBal = wb.adaDec;
                aBal = pair.a.token_id === "lovelace" ? wb.adaDec : (wb.tokens[pair.a.token_id]?.amountDec ?? 0);
                bBal = pair.b.token_id === "lovelace" ? wb.adaDec : (wb.tokens[pair.b.token_id]?.amountDec ?? 0);
            }

            if (buy) {
                let inAmountDec = sizeWithCaps(cfg, "BUY_B", { ada: adaBal, a: aBal, b: bBal }, cfg.AMOUNT_A_DEC);
                if (pair.a.token_id === "lovelace") {
                    inAmountDec = applyAdaReserve(inAmountDec, adaBal, cfg.RESERVE_ADA_DEC);
                }
                if (passesMinTrade(cfg, "BUY_B", inAmountDec) && inAmountDec > 0) {
                    await simulateOrExecute(cfg, "BUY_B", cfg.TOKEN_A, cfg.TOKEN_B, inAmountDec, senderAddress);
                    appendFillCsv(cfg.LOG, { ts: new Date().toISOString(), side: "BUY_B", price: mid, inAmountDec, outAmountDec: 0, center, bandLo: lo, bandHi: hi });
                    coolingUntil = now + cfg.COOLDOWN_MS;
                }
            } else if (sell) {
                const wanted = cfg.AMOUNT_B_DEC;
                const inAmountDec = sizeWithCaps(cfg, "SELL_B", { ada: adaBal, a: aBal, b: bBal }, wanted);
                if (passesMinTrade(cfg, "SELL_B", inAmountDec) && inAmountDec > 0) {
                    await simulateOrExecute(cfg, "SELL_B", cfg.TOKEN_B, cfg.TOKEN_A, inAmountDec, senderAddress);
                    appendFillCsv(cfg.LOG, { ts: new Date().toISOString(), side: "SELL_B", price: mid, inAmountDec, outAmountDec: 0, center, bandLo: lo, bandHi: hi });
                    coolingUntil = now + cfg.COOLDOWN_MS;
                }
            }

            await sleep(cfg.POLL_MS);
        } catch (e: any) {
            log.error(e?.message || e);
            await sleep(5000);
        }
    }
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
