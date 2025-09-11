import "dotenv/config";
import { Lucid, Blockfrost } from "lucid-cardano";

async function main() {
    const lucid = await Lucid.new(
        new Blockfrost("https://cardano-mainnet.blockfrost.io/api/v0", process.env.BLOCKFROST_PROJECT_ID!),
        "Mainnet"
    );
    await lucid.selectWalletFromPrivateKey(process.env.PRIVKEY!);
    console.log("Mainnet address:", await lucid.wallet.address());
}
main().catch(console.error);
