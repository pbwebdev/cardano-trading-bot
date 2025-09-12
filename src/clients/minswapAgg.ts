// --- filepath: src/clients/minswapAgg.ts ---
import axios from "axios";
import type { AppConfig } from "../config.js";
import { floorToDp } from "../util/units.js";
import type { Unit, TokenInfo } from "../types.js";

const HEX_RE = /^[0-9a-f]+$/i;
function isAssetIdLike(s: string) {
    return HEX_RE.test(s) && s.length >= 20;
}

/**
 * Resolve a human token string to an aggregator token_id.
 * - "ADA" → "lovelace"
 * - policy+asset hex → unchanged
 * - otherwise look up via /aggregator/tokens
 */
export async function resolveUnit(cfg: AppConfig, u: string, onlyVerified = true): Promise<Unit> {
    const t = (u ?? "").trim();
    if (!t) throw new Error("Empty token symbol");
    if (t.toLowerCase() === "ada" || t === "lovelace") return "lovelace";
    if (isAssetIdLike(t)) return t;

    const url = `${cfg.AGG_URL}/tokens`;
    const { data } = await axios.post(url, {
        query: t,
        only_verified: !!onlyVerified,
        assets: [],
    });

    const tokens: TokenInfo[] = data?.tokens ?? [];
    if (!tokens.length) throw new Error(`Token lookup returned 0 results for "${u}"`);

    const exactTicker = tokens.find(x => (x.ticker ?? "").toUpperCase() === t.toUpperCase());
    const byName = tokens.find(x => (x.project_name ?? "").toUpperCase() === t.toUpperCase());
    const chosen = exactTicker ?? byName ?? tokens[0];

    if (!chosen?.token_id) throw new Error(`Token lookup failed for "${u}"`);
    return chosen.token_id as string;
}


export async function getTokenDecimals(cfg: AppConfig, unit: Unit): Promise<number> {
    const token_id = await resolveUnit(cfg, unit, cfg.ONLY_VERIFIED_BOOL);
    if (token_id === "lovelace") return 6;
    const infos = await getTokenInfos(cfg, [token_id]);
    const dec = Number(infos?.[0]?.decimals ?? 6);
    return Number.isFinite(dec) && dec >= 0 && dec <= 18 ? dec : 6;
}

export async function getTokenInfos(cfg: AppConfig, assets: string[]): Promise<TokenInfo[]> {
    const a = (assets || []).filter(Boolean);
    if (!a.length) return [];
    const url = `${cfg.AGG_URL}/tokens`;
    const { data } = await axios.post(url, {
        query: "",
        only_verified: !!cfg.ONLY_VERIFIED_BOOL,
        assets: a,
    });
    return (data?.tokens ?? []) as TokenInfo[];
}

export async function resolvePairVerbose(cfg: AppConfig, a: string, b: string) {
    const aId = await resolveUnit(cfg, a, cfg.ONLY_VERIFIED_BOOL);
    const bId = await resolveUnit(cfg, b, cfg.ONLY_VERIFIED_BOOL);
    const infos = await getTokenInfos(cfg, [aId, bId].filter(x => x !== "lovelace"));
    const adaInfo: TokenInfo = { token_id: "lovelace", ticker: "ADA", project_name: "Cardano", decimals: 6 };
    const infoMap: Record<string, TokenInfo> = Object.fromEntries(infos.map(i => [i.token_id, i]));
    return {
        a: aId === "lovelace" ? adaInfo : (infoMap[aId] ?? { token_id: aId }),
        b: bId === "lovelace" ? adaInfo : (infoMap[bId] ?? { token_id: bId }),
    };
}

export async function floorAmountForUnitDecimal(cfg: AppConfig, unit: Unit, amountDec: number | string): Promise<string> {
    const dp = await getTokenDecimals(cfg, unit);
    return floorToDp(amountDec, dp);
}

export async function getMidPrice(cfg: AppConfig, unitA: Unit, unitB: Unit): Promise<number> {
    const token_in = await resolveUnit(cfg, unitA, cfg.ONLY_VERIFIED_BOOL);
    const token_out = await resolveUnit(cfg, unitB, cfg.ONLY_VERIFIED_BOOL);

    const url = `${cfg.AGG_URL}/estimate`;
    const { data } = await axios.post(url, {
        amount: "1",
        token_in,
        token_out,
        slippage: cfg.SLIPPAGE_PCT,
        allow_multi_hops: true,
        amount_in_decimal: true,
    });

    const ain = Number(data?.amount_in);
    const aout = Number(data?.amount_out);
    if (!Number.isFinite(ain) || !Number.isFinite(aout) || ain <= 0) {
        throw new Error("Bad estimate response");
    }
    return aout / ain;
}

export async function estimateSwap(
    cfg: AppConfig,
    inUnit: Unit,
    outUnit: Unit,
    inAmountDec: number
) {
    const token_in = await resolveUnit(cfg, inUnit, cfg.ONLY_VERIFIED_BOOL);
    const token_out = await resolveUnit(cfg, outUnit, cfg.ONLY_VERIFIED_BOOL);

    const url = `${cfg.AGG_URL}/estimate`;
    const { data } = await axios.post(url, {
        amount: await floorAmountForUnitDecimal(cfg, inUnit, inAmountDec),
        token_in,
        token_out,
        slippage: cfg.SLIPPAGE_PCT,
        allow_multi_hops: true,
        amount_in_decimal: true,
    });

    return {
        token_in,
        token_out,
        amount_in: Number(data?.amount_in),
        amount_out: Number(data?.amount_out),
        min_amount_out: Number(data?.min_amount_out),
        avg_price_impact: Number(data?.avg_price_impact ?? 0),
        aggregator_fee_percent: Number(data?.aggregator_fee_percent ?? 0),
        paths: data?.paths ?? [],
    };
}
