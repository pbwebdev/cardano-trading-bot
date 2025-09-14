# Waveband Cardano Trading Bot

![Waveband Cardano Trading Bot](https://raw.githubusercontent.com/pbwebdev/cardano-trading-bot/refs/heads/master/waveband-cardano-crypto-trading-bot-logo.png)


Automate trading on the Cardano blockchain using Minswap’s Aggregator API for the best swap prices and TapTools API for backtesting.  
This bot implements an EMA-band trading strategy with risk management, stop-loss, portfolio % trades, and configurable parameters.

## Features

- **EMA Band Strategy** – buy low, sell high around a moving average band.  
- **DEX Aggregation** – always gets the best swap price via Minswap Aggregator.  
- **Backtesting** – test strategies with TapTools data before risking real funds.  
- **Risk Controls** – slippage guard, fee caps, min trade size, max % allocation.  
- **Dry Mode** – test without sending real transactions.  
- **PM2 Support** – manage bots easily with multiple market pairs.  
- **Logging** – CSV trade logs for PnL tracking.

---

## Prerequisites

- Node.js 18+  
- pnpm (preferred) or npm  
- A funded **Cardano wallet private key** (enterprise key recommended).  
- Blockfrost API key (for your chosen network).  
- TapTools API key (for backtesting).  

---

## Installation

Clone and install dependencies:

```bash
git clone https://github.com/pbwebdev/cardano-trading-bot.git
cd cardano-trading-bot
pnpm install
```

---

## Configuration

All configuration is done via `.env` files.  
Examples are provided:  

- `env.example` – general template  
- `env.example.ada-strike` – trading ADA/STRIKE example  
- `env.example.dry-mode` – safe test mode  

Copy and edit one:

```bash
cp env.example.ada-strike .env.ada-strike
```

### Important Parameters

```ini
# Mode
DRY_RUN=true                # true = no real trades, false = live trades
ONLY_VERIFIED=true          # only use verified pools

# Network
NETWORK=Mainnet             # or Preprod / Preview
BLOCKFROST_PROJECT_ID=...   # your Blockfrost API key
TAPTOOLS_API_KEY=...        # your TapTools API key for backtests

# Logging
LOG=fills.ada-strike.csv    # CSV log file
CENTER_FILE=.band-center.json

# Token pair
TOKEN_A=ADA                 # base token
TOKEN_B=STRIKE              # quote token

# Trade sizing
AMOUNT_A_DEC=100            # trade amount of token A in decimals
AMOUNT_B_DEC=50             # trade amount of token B in decimals
RESERVE_ADA_DEC=250         # ADA kept in wallet, never traded

# Strategy parameters
SLIPPAGE_PCT=0.35           # max % slippage allowed
FEE_CAP_PCT=0.25            # max % fees allowed
BAND_BPS=35                 # band width (basis points)
BAND_ALPHA=0.20             # EMA smoothing factor
EDGE_BPS=3                  # edge trigger before trade executes

# Trade frequency
COOLDOWN_MS=45000           # minimum ms between trades
POLL_MS=22000               # price check interval

# Risk controls
MIN_NOTIONAL_OUT=30         # minimum trade output value
MAX_PCT_A=15                # max % of Token A portfolio in one trade
MAX_PCT_B=15                # max % of Token B portfolio in one trade
MIN_TRADE_A_DEC=10          # minimum trade amount of Token A
MIN_TRADE_B_DEC=5           # minimum trade amount of Token B
```

---

## Running the Bot

### Dry Run (safe mode)
```bash
$env:DOTENV_CONFIG_PATH=".env.ada-strike"
npx tsx src/bot.ts
```

### Live Mode with PM2
```bash
pm2 start ecosystem.config.cjs --only bot:ada-strike
pm2 logs bot:ada-strike
```

Stop the bot:
```bash
pm2 stop bot:ada-strike
```

---

## Backtesting

Use TapTools data to test strategies.

```bash
$env:DOTENV_CONFIG_PATH=".env.ada-strike"
npx tsx src/backtest-taptools.ts
```

Run parameter sweeps:
```bash
$env:DOTENV_CONFIG_PATH=".env.ada-strike"
npx tsx src/backtest-sweep.ts
```

Results are logged to CSV for analysis.

---

## Project Structure

```
src/
  backtest-sweep.ts        # Backtest sweeps
  backtest-taptools.ts     # TapTools backtest
  bot.ts                   # Main trading bot
  clients/                 # Blockfrost, aggregator, wallet clients
  execution/               # Trade execution
  persistence/             # State management
  strategy/                # EMA-band strategy
  util/                    # Logging, formatting, helpers
```

---

## Notes

- Always start in **DRY_RUN mode** before going live.  
- Adjust `.env` parameters to suit your risk appetite.  
- Keep a reserve of ADA to pay for transaction fees.  
- You can run multiple bots with different `.env` configs using PM2.  

---

## License

MIT

Create by the team at Mesh With Us, [Cardano Blockchain Development, Gold Coast](https://meshwithus.com.au/services/cardano-blockchain-development-gold-coast/).