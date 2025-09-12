// --- filepath: src/execution/executor.ts ---
import axios from "axios";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { createHash } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { Unit } from "../types.js";
import { estimateSwap, resolveUnit, floorAmountForUnitDecimal } from "../clients/minswapAgg.js";
import { log } from "../util/logger.js";

export async function simulateOrExecute(
    cfg: AppConfig,
    side: "BUY_B" | "SELL_B",
    inUnit: Unit,
    outUnit: Unit,
    inAmountDec: number,
    senderAddress?: string
) {
    // 1) Price/route estimation
    const est = await estimateSwap(cfg, inUnit, outUnit, inAmountDec);

    // Guard: aggregator fee cap (optional)
    const feePct = (est.aggregator_fee_percent ?? 0) / 100; // percent -> fraction
    if (feePct > (cfg.FEE_CAP_PCT / 100)) {
        throw new Error(`Fee cap exceeded: ${(feePct * 100).toFixed(2)}%`);
    }

    // Dry-run or missing keys/address → simulate only
    if (cfg.DRY_RUN_BOOL || !senderAddress || !cfg.PRIVKEY) {
        log.info("[dry]", side, { in: est.amount_in, out: est.amount_out, minOut: est.min_amount_out });
        return { tx_id: undefined, ...est };
    }

    // 2) Build unsigned tx CBOR
    const token_in = await resolveUnit(cfg, inUnit, cfg.ONLY_VERIFIED_BOOL);
    const token_out = await resolveUnit(cfg, outUnit, cfg.ONLY_VERIFIED_BOOL);

    const buildBody = {
        sender: senderAddress,
        min_amount_out: String(est.min_amount_out),
        estimate: {
            amount: await floorAmountForUnitDecimal(cfg, inUnit, inAmountDec),
            token_in,
            token_out,
            slippage: cfg.SLIPPAGE_PCT,
            allow_multi_hops: true,
        },
        amount_in_decimal: true,
    };

    const buildUrl = `${cfg.AGG_URL}/build-tx`;
    const buildRes = await axios.post(buildUrl, buildBody);
    const cborHex: string = buildRes.data?.cbor;
    if (!cborHex) throw new Error("Aggregator build-tx returned no CBOR");

    // 3) Make witness set by signing the tx body hash (robust across encodings)
    const witnessHex = signWitnessForUnsignedTx(cborHex, cfg.PRIVKEY);

    // 4) Submit (send original CBOR + produced witness_set)
    const submitUrl = `${cfg.AGG_URL}/finalize-and-submit-tx`;
    const submitRes = await axios.post(submitUrl, { cbor: cborHex, witness_set: witnessHex });
    const tx_id: string = submitRes.data?.tx_id;
    if (!tx_id) throw new Error("No tx_id returned by finalize-and-submit-tx");

    log.info("[live]", side, { tx_id, in: est.amount_in, out: est.amount_out, minOut: est.min_amount_out });
    return { tx_id, ...est };
}

/* ======================== helpers ======================== */

function signWitnessForUnsignedTx(unsignedTxCborHex: string, privKeyInput: string): string {
    // Load private key (bech32 ed25519_sk1... or raw hex)
    let priv: CSL.PrivateKey;
    if (privKeyInput.startsWith("ed25519_sk1")) {
        priv = CSL.PrivateKey.from_bech32(privKeyInput);
    } else {
        const raw = Uint8Array.from(Buffer.from(privKeyInput, "hex"));
        priv = CSL.PrivateKey.from_normal_bytes(raw);
    }

    // Derive TransactionHash of the BODY (no witnesses/aux)
    const txHash = getTxBodyHash(unsignedTxCborHex);

    // Create vkey witness set
    const vkeyWitness = CSL.make_vkey_witness(txHash, priv);
    const vkeys = CSL.Vkeywitnesses.new();
    vkeys.add(vkeyWitness);
    const ws = CSL.TransactionWitnessSet.new();
    ws.set_vkeys(vkeys);

    return Buffer.from(ws.to_bytes()).toString("hex");
}

/**
 * Compute the transaction body hash from the unsigned tx CBOR hex.
 * Works with:
 *  - Tag(24)-wrapped CBOR (unwraps)
 *  - Full Transaction (hash blake2b256(body.to_bytes()))
 *  - Raw TransactionBody (hash blake2b256(body.to_bytes()))
 *  - FixedTransaction (CSL v15+: uses its raw body / transaction_hash)
 */
function getTxBodyHash(unsignedTxCborHex: string): CSL.TransactionHash {
    // Normalize: strip Tag(24) wrapper if present
    const normalizedHex = stripTag24IfPresent(unsignedTxCborHex);
    const bytes = hexToBytes(normalizedHex);

    // 1) Prefer FixedTransaction (CSL v15+), if available
    try {
        const FixedTx: any = (CSL as any).FixedTransaction;
        if (FixedTx) {
            let ftx: any;
            try {
                // Some builds expose from_bytes only, some both
                ftx = typeof FixedTx.from_bytes === "function"
                    ? FixedTx.from_bytes(bytes)
                    : FixedTx.from_hex(normalizedHex);
            } catch {
                ftx = undefined;
            }
            if (ftx) {
                if (typeof ftx.transaction_hash === "function") {
                    return ftx.transaction_hash() as CSL.TransactionHash;
                }
                if (typeof ftx.raw_body === "function") {
                    const bodyBytes: Uint8Array = ftx.raw_body();
                    return CSL.TransactionHash.from_bytes(blake2b256(bodyBytes));
                }
            }
        }
    } catch (e) {
        // ignore; fall through to classic parsing
    }

    // 2) Try as full Transaction (array)
    try {
        const tx = CSL.Transaction.from_bytes(bytes);
        const bodyBytes = tx.body().to_bytes();
        return CSL.TransactionHash.from_bytes(blake2b256(bodyBytes));
    } catch {
        // continue
    }

    // 3) Try as raw TransactionBody (map)
    try {
        const body = CSL.TransactionBody.from_bytes(bytes);
        const bodyBytes = body.to_bytes();
        return CSL.TransactionHash.from_bytes(blake2b256(bodyBytes));
    } catch {
        // continue
    }

    throw new Error("Unable to derive tx body hash from aggregator CBOR");
}

/** Strip a CBOR Tag(24) that wraps a byte string containing CBOR bytes. */
function stripTag24IfPresent(hex: string): string {
    // Tag(24) encoded as: d8 18 58/59/5a/5b <len> <bytes...>
    const buf = Buffer.from(hex, "hex");
    if (buf.length >= 3 && buf[0] === 0xd8 && buf[1] === 0x18) {
        const t = buf[2];
        if (t >= 0x58 && t <= 0x5b) {
            let len = 0;
            let off = 3;
            const sizeBytes = 1 << (t - 0x58); // 1,2,4,8
            for (let i = 0; i < sizeBytes; i++) len = (len << 8) | buf[off + i];
            off += sizeBytes;
            const inner = buf.subarray(off, off + len);
            if (inner.length === len) return inner.toString("hex");
        }
    }
    return hex;
}

function blake2b256(data: Uint8Array): Uint8Array {
    const digest = createHash("blake2b256").update(Buffer.from(data)).digest();
    return Uint8Array.from(digest);
}

function hexToBytes(h: string): Uint8Array {
    return Uint8Array.from(Buffer.from(h, "hex"));
}
