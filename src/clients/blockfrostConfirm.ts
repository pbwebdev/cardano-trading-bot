// --- filepath: src/clients/blockfrostConfirm.ts ---
import axios from "axios";
import type { AppConfig } from "../config.js";

function baseUrl(net: string): string {
    if (net === "Mainnet") return "https://cardano-mainnet.blockfrost.io/api/v0";
    if (net === "Preprod") return "https://cardano-preprod.blockfrost.io/api/v0";
    return "https://cardano-preview.blockfrost.io/api/v0";
}

/**
 * Poll Blockfrost until a tx appears on-chain (200 from /txs/{hash}) or timeout.
 */
export async function waitForTxConfirm(cfg: AppConfig, txId: string): Promise<boolean> {
    const urlBase = baseUrl(cfg.NETWORK);
    const headers = { project_id: cfg.BLOCKFROST_PROJECT_ID };
    const deadline = Date.now() + cfg.CONFIRM_TIMEOUT_MS;

    while (Date.now() < deadline) {
        try {
            const r = await axios.get(`${urlBase}/txs/${txId}`, { headers });
            if (r.status === 200 && r.data?.hash) return true; // confirmed
        } catch (e: any) {
            // 404 -> not found yet (not confirmed); other codes -> keep trying
            if (e?.response?.status && e.response.status !== 404) {
                // brief backoff on unexpected errors
            }
        }
        await new Promise((res) => setTimeout(res, cfg.CONFIRM_POLL_MS));
    }
    return false;
}
