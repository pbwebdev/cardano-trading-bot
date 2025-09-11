// --- filepath: src/clients/blockfrost.ts ---
import { Blockfrost } from "lucid-cardano";
import type { AppConfig } from "../config.js";

export function blockfrostProvider(cfg: AppConfig) {
    const endpoint = cfg.NETWORK === "Mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : cfg.NETWORK === "Preprod"
            ? "https://cardano-preprod.blockfrost.io/api/v0"
            : "https://cardano-preview.blockfrost.io/api/v0";
    return new Blockfrost(endpoint, cfg.BLOCKFROST_PROJECT_ID);
}