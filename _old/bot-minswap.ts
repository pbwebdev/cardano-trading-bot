import "dotenv/config";
import axios from "axios";
import { bech32 } from "bech32";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import { Lucid, Blockfrost } from "lucid-cardano";
import { blake2b } from "blakejs";

// --- Config -------------------------------------------------------------
const NETWORK = (process.env.NETWORK ?? "Mainnet") as "Mainnet" | "Preprod" | "Preview";
const TOKEN_OUT_QUERY = (process.env.TOKEN_OUT ?? "MIN").trim();

// Aggregator is mainnet-only public host
const AGG = "https://agg-api.minswap.org/aggregator";

function blockfrostBase(net: string) {
    return net === "Mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : net === "Preprod"
            ? "https://cardano-preprod.blockfrost.io/api/v0"
            : "https://cardano-preview.blockfrost.io/api/v0";
}

// --- Lucid init ---------------------------------------------------------
async function makeLucid() {
    const lucid = await Lucid.new(
        new Blockfrost(blockfrostBase(NETWORK), process.env.BLOCKFROST_PROJECT_ID!),
        NETWORK
    );
    await lucid.selectWalletFromPrivateKey(process.env.PRIVKEY!);
    return lucid;
}

// --- Sign (witness-set) -------------------------------------------------
function makeWitness(txCborHex: string, bech32Sk: string): string {
    const { words } = bech32.decode(bech32Sk, 2048);
    const skBytes = Buffer.from(bech32.fromWords(words));
    const sk =
        skBytes.length === 96
            ? CSL.PrivateKey.from_extended_bytes(skBytes)
            : CSL.PrivateKey.from_normal_bytes(skBytes);

    const tx = CSL.Transaction.from_bytes(Buffer.from(txCborHex, "hex"));

    // blake2b-256(tx_body_cbor)
    const bodyBytes = tx.body().to_bytes();
    const hashBytes = blake2b(bodyBytes, undefined, 32); // Uint8Array
    const txHash = CSL.TransactionHash.from_bytes(hashBytes);

    const vkeyWitness = CSL.make_vkey_witness(txHash, sk);
    const vkeys = CSL.Vkeywitnesses.new();
    vkeys.add(vkeyWitness);

    const ws = CSL.TransactionWitnessSet.new();
    ws.set_vkeys(vkeys);

    return Buffer.from(ws.to_bytes()).toString("hex");
}

// --- Token resolver -----------------------------------------------------
// Accepts human ticker (e.g. "MIN") OR full unit "policyId.assetNameHex"
async function resolveTokenId(query: string): Promise<string> {
    if (/^[0-9a-f]{20,}\.[0-9a-f]+$/i.test(query)) return query;

    const resp = await axios.post(`${AGG}/tokens`, {
        query,
        only_verified: false
    });

    const items: Array<any> = resp.data?.tokens ?? [];
    if (!items.length) {
        throw new Error(`Token not found on Mainnet for "${query}". Try full policyId.assetNameHex.`);
    }

    const exact = items.find(
        (t) => typeof t.ticker === "string" && t.ticker.toLowerCase() === query.toLowerCase()
    );
    const chosen = exact ?? items[0];

    console.log(
        `Token resolved: ${chosen.ticker ?? "(no ticker)"} | unit=${chosen.token_id} | name=${chosen.name ?? ""}`
    );
    return chosen.token_id; // policyId.assetNameHex
}

// --- Confirm helper -----------------------------------------------------
async function waitForConfirm(bfKey: string, txHash: string, timeoutMs = 120_000) {
    const base = "https://cardano-mainnet.blockfrost.io/api/v0";
    const start = Date.now();
    for (;;) {
        try {
            const r = await axios.get(`${base}/txs/${txHash}`, { headers: { project_id: bfKey } });
            if (r.status === 200) return r.data;
        } catch {}
        if (Date.now() - start > timeoutMs) throw new Error("confirm timeout");
        await new Promise((r) => setTimeout(r, 4000));
    }
}

// --- Main ---------------------------------------------------------------
(async () => {
    const lucid = await makeLucid();
    const sender = await lucid.wallet.address();

    // Resolve tokenOut dynamically
    const tokenOut = await resolveTokenId(TOKEN_OUT_QUERY);

    // Example swap config
    const amount = BigInt(process.env.AMOUNT_LOVELACE ?? "2000000"); // 2 ADA default
    const tokenIn = "lovelace";
    const slippagePct = Number(process.env.SLIPPAGE_PCT ?? "0.5");

    // Ensure we have enough ADA for input + fees (use bigint)
    const utxos = await lucid.wallet.getUtxos();
    const totalAda: bigint = utxos.reduce((s, u) => s + BigInt(u.assets.lovelace ?? 0n), 0n);

    // Require: amount + a buffer for fees (≈ 1–2 ADA is plenty for safety)
    const feeBuffer = 2_000_000n; // 2 ADA buffer
    const required = amount + feeBuffer;
    if (totalAda < required) {
        throw new Error(`Top up ADA or lower amount. Need ≥ ${required} lovelace, have ${totalAda}.`);
    }

    if (slippagePct > 1.0) throw new Error("Slippage too high");

    // 1) Estimate (keep the request you send)
    const estimateReq = {
        amount: amount.toString(),
        token_in: tokenIn,
        token_out: tokenOut,
        slippage: slippagePct,
        allow_multi_hops: true
    } as const;

    const estimateRes = (await axios.post(`${AGG}/estimate`, estimateReq)).data;

    // Log min out & fees
    const outMin = BigInt(estimateRes.min_amount_out);
    const aggFeePct = Number(estimateRes.aggregator_fee_percent ?? 0);
    console.log(`Min out: ${outMin} | Agg fee: ${aggFeePct}%`);

    // Fee guard
    if (aggFeePct > 0.2) throw new Error(`Aggregator fee too high: ${aggFeePct}%`);

    // 2) Build — include original request + response merged AND min_amount_out at top level
    const build = (
        await axios.post(`${AGG}/build-tx`, {
            sender,
            min_amount_out: estimateRes.min_amount_out,
            estimate: { ...estimateReq, ...estimateRes }
        })
    ).data;

    const unsignedCborHex: string = build.cbor;

    // 3) Sign
    const witnessHex = makeWitness(unsignedCborHex, process.env.PRIVKEY!);

    // 4) Finalize & submit (via Aggregator)
    const finalized = (
        await axios.post(`${AGG}/finalize-and-submit-tx`, {
            cbor: unsignedCborHex,
            witness_set: witnessHex
        })
    ).data;

    console.log(`Submitted tx: ${finalized.tx_id} on ${NETWORK}`);

    // 5) Wait for confirmation (optional but recommended)
    await waitForConfirm(process.env.BLOCKFROST_PROJECT_ID!, finalized.tx_id);
    console.log("Confirmed:", finalized.tx_id);
})().catch((e) => {
    if (axios.isAxiosError(e)) {
        console.error("HTTP", e.response?.status, e.response?.data ?? e.message);
    } else {
        console.error(e);
    }
});
