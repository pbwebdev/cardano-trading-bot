// --- filepath: src/wallet.ts ---
import { Lucid } from "lucid-cardano";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import type { AppConfig } from "./config.js";
import { blockfrostProvider } from "./clients/blockfrost.js";

export async function initLucid(cfg: AppConfig) {
    const lucid = await Lucid.new(blockfrostProvider(cfg), cfg.NETWORK);
    if (!cfg.PRIVKEY) return { lucid, address: cfg.ADDRESS! };

    let priv: CSL.PrivateKey;
    if (cfg.PRIVKEY.startsWith("ed25519_sk1")) {
        priv = CSL.PrivateKey.from_bech32(cfg.PRIVKEY);
    } else {
        const raw = Uint8Array.from(Buffer.from(cfg.PRIVKEY, "hex"));
        priv = CSL.PrivateKey.from_normal_bytes(raw);
    }
    const bech = priv.to_bech32();
    lucid.selectWalletFromPrivateKey(bech);
    const address = await lucid.wallet.address();
    return { lucid, address };
}