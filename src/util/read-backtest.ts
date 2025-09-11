import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "backtest_trades.csv");
const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1);

let sellsA = 0, sellsB = 0;
let grossAdaOut = 0, grossAdaIn = 0;

for (const line of rows) {
    const [ts, side, mid, center, lower, upper, amount_in, token_in, amount_out, token_out, fee_bps] = line.split(",");
    if (side === "SELL_A") {
        // A=ADA -> get B; grossAdaOut increases by ADA spent
        grossAdaOut += Number(amount_in);
        sellsA++;
    } else if (side === "SELL_B") {
        // B -> get ADA; grossAdaIn increases by ADA received
        grossAdaIn += Number(amount_out);
        sellsB++;
    }
}

console.log(`Trades: ${rows.length} | SELL_A: ${sellsA} | SELL_B: ${sellsB}`);
console.log(`Gross ADA spent: ${grossAdaOut.toFixed(6)} | Gross ADA received: ${grossAdaIn.toFixed(6)}`);
console.log(`Net ADA from SELL_B legs: ${(grossAdaIn - grossAdaOut).toFixed(6)} (ignores remaining B inventory)`);
