## Cardano Trading Bot

This bot automates DeFi trading on Cardano using an EMA band strategy with risk controls. It integrates with the Minswap DEX Aggregator API for routing and TapTools for historical price data used in backtests and parameter sweeps.

### Requirements
- Node.js v18+ and npm or pnpm or yarn
- Git
- Blockfrost account and project id
- TapTools API key
- A funded Cardano address and private key for live trading
- PM2 for process management in production

### Install
```bash
git clone https://github.com/pbwebdev/cardano-trading-bot.git
cd cardano-trading-bot
pnpm install   # or: npm install / yarn install
```

### Configuration overview
The project uses environment files so you can safely separate global settings from per-pair and testing configs.

#### Global `.env`
Shared variables such as network and API keys.
```ini
DRY_RUN=true
ONLY_VERIFIED=true

NETWORK=Mainnet
BLOCKFROST_PROJECT_ID=your_blockfrost_project_id
TAPTOOLS_API_KEY=your_taptools_api_key
```

#### Pair-specific `.env` for live trading
Example for ADA-USDM: `.env.ada-usdm`
```ini
LOG=fills.ada-usdm.csv
CENTER_FILE=.band-center.ada-usdm.json

TOKEN_A=ADA
TOKEN_B=USDM
AMOUNT_A_DEC=100
AMOUNT_B_DEC=50

SLIPPAGE_PCT=0.35
FEE_CAP_PCT=0.20
BAND_BPS=35
BAND_ALPHA=0.20
EDGE_BPS=3

COOLDOWN_MS=45000
POLL_MS=22000

MIN_NOTIONAL_OUT=30
MAX_PCT_A=15
MAX_PCT_B=15
MIN_TRADE_A_DEC=10
MIN_TRADE_B_DEC=5
RESERVE_ADA_DEC=250
```

### Dry mode, backtesting and sweeps
For testing and research, keep a dedicated file so you do not pollute live settings. Recommended file name: `.env.dry-mode`. It includes live-like defaults plus backtest and sweep variables. See the full commented example at the end of this README insert.

Key backtest variables used by `src/backtest-taptools.ts`:
- `BT_INTERVAL`, `BT_MAX_POINTS`, `BT_START_EPOCH`, `BT_END_EPOCH`, `BT_PRICE_IS_B_PER_A`
- `BT_POOL_FEE_BPS`, `BT_AGG_FEE_BPS`, `BT_COOLDOWN_MS`
- `BT_START_ADA`, `BT_START_TOKB`
- `BT_DECISION_EVERY_MS`

Key sweep variables used by `src/backtest-sweep.ts`:
- `SWEEP_BAND_BPS`, `SWEEP_EDGE_BPS`, `SWEEP_ALPHA`
- `SWEEP_MAX_PCT_A`, `SWEEP_MAX_PCT_B`, `SWEEP_MIN_TRADE_A`, `SWEEP_MIN_TRADE_B`
- `SWEEP_MIN_CYCLE_PNL_BPS`, `SWEEP_TRAIL_STOP_BPS`, `SWEEP_HARD_STOP_BPS`
- `SWEEP_DECISION_EVERY_MS`

### Run the live bot
```bash
# Windows PowerShell
$env:DOTENV_CONFIG_PATH=".env.ada-usdm"
npx tsx src/bot-twoway.ts

# macOS or Linux
export DOTENV_CONFIG_PATH=".env.ada-usdm"
npx tsx src/bot-twoway.ts
```

### Run a backtest
```bash
# Use the dry mode config
export DOTENV_CONFIG_PATH=".env.dry-mode"
npx tsx src/backtest-taptools.ts
```

### Run a parameter sweep
```bash
export DOTENV_CONFIG_PATH=".env.dry-mode"
npx tsx src/backtest-sweep.ts
```
- The sweep script expands every combination from the comma separated `SWEEP_*` ranges and writes a consolidated CSV of results.

### PM2 process management
```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs
pm2 restart <id|name>
pm2 stop <id|name>
```

### Logs and persistent state
- Trade fills: `fills.<pair>.csv`
- Band centre state: `.band-center.<pair>.json`
- Backtest results: CSV per run
- Sweep results: consolidated CSV

### Tips
- Start with `DRY_RUN=true` to validate routing, logging and constraints.
- Set `ONLY_VERIFIED=true` to prefer deeper liquidity.
- Keep `RESERVE_ADA_DEC` high enough for fees and routing.
- Align `DECISION_EVERY_MS`, `BT_DECISION_EVERY_MS` and `SWEEP_DECISION_EVERY_MS` when validating decision cadence.
- Maintain separate env files per pair and for dry mode.
