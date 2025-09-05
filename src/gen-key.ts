import "dotenv/config";
import { Lucid, Blockfrost, generatePrivateKey } from "lucid-cardano";

function blockfrostBase(net: string) {
    return net === "Mainnet"
        ? "https://cardano-mainnet.blockfrost.io/api/v0"
        : net === "Preprod"
            ? "https://cardano-preprod.blockfrost.io/api/v0"
            : "https://cardano-preview.blockfrost.io/api/v0";
}

async function main() {
    const network = (process.env.NETWORK ?? "Preprod") as "Mainnet" | "Preprod" | "Preview";

    const lucid = await Lucid.new(
        new Blockfrost(blockfrostBase(network), process.env.BLOCKFROST_PROJECT_ID!),
        network
    );

    const sk = generatePrivateKey(); // bech32 ed25519_sk...
    await lucid.selectWalletFromPrivateKey(sk);
    const address = await lucid.wallet.address();

    console.log("PRIVATE KEY (store securely):", sk);
    console.log("ADDRESS:", address);
}

main().catch(console.error);
