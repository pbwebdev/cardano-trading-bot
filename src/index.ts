// --- filepath: src/index.ts ---
import { runBot } from "./bot.js";
runBot().catch((e) => { console.error(e); process.exit(1); });
