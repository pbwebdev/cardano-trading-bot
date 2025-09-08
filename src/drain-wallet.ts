// src/drain-wallet.ts
import "dotenv/config";
import { Lucid, Blockfrost, Assets, UTxO } from "lucid-cardano";
import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import fs from "node:fs";

// ---------- ENV ----------
type Net = "Mainnet" | "Preprod" | "Preview";
const NETWORK = (process.env.NETWORK ?? "Mainnet") as Net;
const BLOCKFROST_KEY = process.env.BLOCKFROST_PROJECT_ID!;
const PRIVKEY = process.env.PRIVKEY!;
const DEST = (process.env.DEST_ADDRESS ?? "").trim();
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";
// Leave this much ADA in the wallet (human units). Example: 1.5 = leave ~1.5 ADA
const LEAVE_ADA_DEC = Number(process.env.LEAVE_ADA_DEC ?? "0"); // 0 = leave nothing

if (!BLOCKFROST_KEY) throw new Error("Missing BLOCKFROST_PROJECT_ID in env.");
if (!PRIVKEY) throw new Error("Missing PRIVKEY in env.");
if (!DEST) throw new Error("Missing DEST_ADDRESS in env.");

// ---------- Helpers ----------
function blockfrostBase(net: Net) {
    return net === "Mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : net === "Preprod"
            ? "https://cardano-preprod.blockfrost.io/api/v0"
            : "https://cardano-preview.blockfrost.io/api/v0";
}

async function makeLucid(): Promise<Lucid> {
    const lucid = await Lucid.new(
        new Blockfrost(blockfrostBase(NETWORK), BLOCKFROST_KEY),
        NETWORK
    );
    await lucid.selectWalletFromPrivateKey(PRIVKEY);
    return lucid;
}

function sumAssets(utxos: UTxO[]): Assets {
    const tot: Assets = {};
    for (const u of utxos) {
        for (const [k, v] of Object.entries(u.assets)) {
            const cur = BigInt(v as any);
            tot[k] = (tot[k] ?? 0n) + cur;
        }
    }
    return tot;
}

// ---------- Main ----------
async function main() {
    const lucid = await makeLucid();
    const source = await lucid.wallet.address();

    console.log("Source:", source);
    console.log("Destination:", DEST);
    console.log("Network:", NETWORK);
    console.log("DRY_RUN:", DRY_RUN);

    if (DEST === source) {
        console.warn(
            "DEST_ADDRESS equals your source wallet address. Drain will effectively do nothing."
        );
    }

    // Gather all UTxOs
    const utxos = await lucid.wallet.getUtxos();
    if (utxos.length === 0) {
        console.log("No UTxOs to drain.");
        return;
    }

    // Sum all assets
    const totals = sumAssets(utxos);
    console.log("---- Totals (raw) ----");
    for (const [unit, amt] of Object.entries(totals)) {
        console.log(`${unit} = ${amt.toString()}`);
    }
    console.log("----------------------");

    // Build assets map to explicitly send *non-ADA* to DEST.
    // ADA will be sent via "change" to DEST in .complete({ changeAddress: DEST }).
    const nonAda: Assets = {};
    for (const [unit, amt] of Object.entries(totals)) {
        if (unit === "lovelace") continue;
        nonAda[unit] = amt as bigint;
    }

    // If you want to leave some ADA in the source wallet, reduce ADA we send as change by that.
    // Implementation approach:
    // - If LEAVE_ADA_DEC > 0, we add a small output back to the source wallet with that much ADA.
    //   That ensures the fee algorithm keeps that ADA at source.
    const leaveAdaLovelace =
        LEAVE_ADA_DEC > 0 ? BigInt(Math.round(LEAVE_ADA_DEC * 1_000_000)) : 0n;

    let txBuilder = lucid.newTx().collectFrom(utxos);

    // Pay all non-ADA explicitly to DEST
    if (Object.keys(nonAda).length > 0) {
        txBuilder = txBuilder.payToAddress(DEST, nonAda);
    }

    // If leaving ADA, create a tiny change output back to source for that amount.
    // Use payToAddress here (Lucid ensures min-ADA constraints during completion).
    if (leaveAdaLovelace > 0n) {
        txBuilder = txBuilder.payToAddress(source, { lovelace: leaveAdaLovelace });
    }

    // Complete with change set to DEST so **all remaining ADA after fee** goes to DEST.
    const tx = await (txBuilder as any).complete({ changeAddress: DEST });

    // Estimate fee by parsing unsigned CBOR with CSL
    const txCborHex = tx.toString(); // unsigned CBOR hex
    const txObj = CSL.Transaction.from_bytes(Buffer.from(txCborHex, "hex"));
    const fee = BigInt(txObj.body().fee().to_str()); // lovelace

    if (DRY_RUN) {
        console.log("---- DRY RUN ----");
        console.log("Estimated fee (lovelace):", fee.toString());
        if (leaveAdaLovelace > 0n) {
            console.log(
                `Will leave ~${LEAVE_ADA_DEC} ADA at source via explicit output.`
            );
        }
        // Optionally dump the raw unsigned CBOR for record:
        try {
            fs.writeFileSync("drain_unsigned.cbor", txCborHex, "utf8");
            console.log("Wrote unsigned CBOR to drain_unsigned.cbor");
        } catch {}
        return;
    }

    // Sign + submit
    const signed = await tx.sign().complete();
    const txHash = await signed.submit();

    console.log("Submitted tx:", txHash);
}

main().catch((e) => {
    console.error(e?.response?.data ?? e);
    process.exit(1);
});
