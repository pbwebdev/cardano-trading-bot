// --- filepath: src/clients/walletInfo.ts ---
import axios from "axios";
import type { AppConfig } from "../config.js";
import type { Unit, WalletBalances, TokenInfo } from "../types.js";

export async function fetchWalletBalances(cfg: AppConfig, address: string): Promise<WalletBalances> {
    try {
        const url = `${cfg.AGG_URL}/wallet`;
        const { data } = await axios.get(url, { params: { address, amount_in_decimal: true } });
        const adaDec = Number(data?.ada ?? 0);
        const tokensArr: any[] = Array.isArray(data?.balance) ? data.balance : [];
        const tokens: WalletBalances["tokens"] = {};
        for (const t of tokensArr) {
            const info = t?.asset as TokenInfo | undefined;
            const id = info?.token_id as Unit;
            if (!id) continue;
            tokens[id] = { amountDec: Number(t?.amount ?? 0), info };
        }
        return { adaDec: isFinite(adaDec) ? adaDec : 0, tokens };
    } catch (e) {
        // Fallback if endpoint unavailable
        return { adaDec: 0, tokens: {} };
    }
}
