// ecosystem.config.cjs (CommonJS so we can use require())
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

function loadEnv(file) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) return {};
    const parsed = dotenv.config({ path: p }).parsed || {};
    return parsed;
}

// ensure logs dir exists
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Shared + per-pair envs
const base = loadEnv(".env.base");

// ADA–USDM instance
const adaUsdm = Object.assign({}, base, loadEnv(".env.ada-usdm"), {
    // per-instance files to avoid clobber
    LOG: "fills.ada-usdm.csv",
    CENTER_FILE: ".band-center.ada-usdm.json",
});

// ADA–STRIKE instance
const adaStrike = Object.assign({}, base, loadEnv(".env.ada-strike"), {
    LOG: "fills.ada-strike.csv",
    CENTER_FILE: ".band-center.ada-strike.json",
});

module.exports = {
    apps: [
        {
            name: "bot:ada-usdm",
            script: "dist/bot-twoway.js",
            env: adaUsdm,
            out_file: "logs/ada-usdm.out.log",
            error_file: "logs/ada-usdm.err.log",
            time: true,
            restart_delay: 5000,
            max_restarts: 25,
        },
        {
            name: "bot:ada-strike",
            script: "dist/bot-twoway.js",
            env: adaStrike,
            out_file: "logs/ada-strike.out.log",
            error_file: "logs/ada-strike.err.log",
            time: true,
            restart_delay: 5000,
            max_restarts: 25,
        },
    ],
};
