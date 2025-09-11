// --- filepath: src/persistence/state.ts ---
import * as fs from "node:fs";
import { dirname } from "node:path";
import type { FillLogRow } from "../types.js";

function ensureDirExists(filePath: string) {
    const dir = dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(v: unknown): string {
    const s = String(v ?? "");
    // Escape quotes and wrap if commas/newlines/quotes present
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function appendFillCsv(path: string, row: FillLogRow) {
    ensureDirExists(path);

    const header =
        "ts,side,price,inAmountDec,outAmountDec,pnlDec,center,bandLo,bandHi,stop,configId\n";

    const fields = [
        row.ts,
        row.side,
        row.price,
        row.inAmountDec,
        row.outAmountDec,
        row.pnlDec ?? "",
        row.center ?? "",
        row.bandLo ?? "",
        row.bandHi ?? "",
        row.stop ?? "",
        row.configId ?? "",
    ].map(csvEscape);

    const line = fields.join(",") + "\n";

    if (!fs.existsSync(path) || fs.readFileSync(path, "utf8").length === 0) {
        fs.writeFileSync(path, header);
    }
    fs.appendFileSync(path, line);
}
