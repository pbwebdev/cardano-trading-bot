// --- filepath: src/config.ts ---
import "dotenv/config";
import { z } from "zod";
import * as fs from "node:fs";

const schema = z.object({
    NETWORK: z.enum(["Mainnet", "Preprod", "Preview"]).default("Mainnet"),
    BLOCKFROST_PROJECT_ID: z.string(),
    AGG_URL: z.string().url().default("https://agg-api.minswap.org/aggregator"),

    TOKEN_A: z.string(),
    TOKEN_B: z.string(),

    // human-unit sizing
    AMOUNT_A_DEC: z.coerce.number().default(0),
    AMOUNT_B_DEC: z.coerce.number().default(0),

    // strategy
    BAND_BPS: z.coerce.number().default(50),
    BAND_ALPHA: z.coerce.number().min(0.0).max(1.0).default(0.06),
    EDGE_BPS: z.coerce.number().default(10),

    // trade/risk
    SLIPPAGE_PCT: z.coerce.number().default(0.5),
    FEE_CAP_PCT: z.coerce.number().default(0.20),
    MIN_NOTIONAL_OUT: z.coerce.number().default(10),
    MAX_PCT_A: z.coerce.number().default(15),
    MAX_PCT_B: z.coerce.number().default(15),
    MIN_TRADE_A_DEC: z.coerce.number().default(5),
    MIN_TRADE_B_DEC: z.coerce.number().default(5),
    RESERVE_ADA_DEC: z.coerce.number().default(0),

    // loop
    POLL_MS: z.coerce.number().default(30000),
    COOLDOWN_MS: z.coerce.number().default(90000),

    // confirmations (optional)
    WAIT_FOR_CONFIRMATIONS: z.coerce.number().default(0),
    CONFIRM_TIMEOUT_MS: z.coerce.number().default(180000),
    CONFIRM_POLL_MS: z.coerce.number().default(5000),

    // toggles
    DRY_RUN: z.string().default("false"),
    ONLY_VERIFIED: z.string().default("true"),

    // files
    LOG: z.string().default("fills.csv"),
    CENTER_FILE: z.string().default(".band-center.json"),

    // wallet
    PRIVKEY: z.string().optional(),
    ADDRESS: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & {
    DRY_RUN_BOOL: boolean;
    ONLY_VERIFIED_BOOL: boolean;
};

export function loadConfig(): AppConfig {
    const parsed = schema.parse(process.env);
    const DRY_RUN_BOOL = (parsed.DRY_RUN ?? "false").toLowerCase() === "true";
    const ONLY_VERIFIED_BOOL = (parsed.ONLY_VERIFIED ?? "true").toLowerCase() === "true";
    console.info("[env] TOKENS(raw)=", parsed.TOKEN_A, "/", parsed.TOKEN_B);
    console.info("[env] DOTENV_CONFIG_PATH=", process.env.DOTENV_CONFIG_PATH);
    console.info("[env] DRY_RUN(resolved)=", DRY_RUN_BOOL);
    return { ...parsed, DRY_RUN_BOOL, ONLY_VERIFIED_BOOL };
}

export function saveCenter(path: string, center: number) {
    fs.writeFileSync(path, JSON.stringify({ center, updatedAt: Date.now() }, null, 2));
}

export function loadCenter(path: string): { center: number; updatedAt: number } | null {
    try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return null; }
}