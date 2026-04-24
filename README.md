# Memecoins trading agent

> Autonomous memecoin trading agent. Watches smart wallets. Scores tokens. Adapts with every trade.

---

## What it does

When 2-5 wallets you trust all buy the same token within minutes of each other, the agent:

1. **Detects the convergence** — real-time via Helius WebSocket
2. **Scores the token** — volume, holders, dev history, distribution (Helius + DexScreener)
3. **Checks CT momentum** — Grok/X API scans crypto twitter for narrative strength
4. **Sizes the position** — 1-10 SOL based on wallet count × score × trust
5. **Executes via Jupiter** — best route, configurable slippage
6. **Manages the exit** — staged exits at 2x/3x/5x + emergency exit if wallets dump
7. **Learns** — after every trade, adjusts score weights and wallet trust scores
8. **Pings you on Telegram** — only when something real happens

---

## Architecture

```
src/
├── agents/
│   ├── walletTracker.ts      Helius WebSocket — monitors 10-30 wallets
│   ├── signalDetector.ts     Convergence engine — 2-5 wallet ape detection
│   ├── tokenAnalyzer.ts      Helius + DexScreener scoring (0-100)
│   ├── ctScanner.ts          Grok / X API CT momentum scanner
│   ├── tradeExecutor.ts      Jupiter swap execution
│   ├── positionManager.ts    Entry tracking, staged exits, stop loss
│   └── learningEngine.ts     Self-improvement via trade history
├── core/
│   ├── orchestrator.ts       The brain — wires all agents together
│   └── notifier.ts           Telegram alerts (minimal pings)
├── soul/
│   ├── SOUL.md               Trencher identity + scoring philosophy
│   └── PERSONALITY.md        Alert voice + decision energy
├── data/db.ts                SQLite — trades, wallet trust, weights
└── config/params.ts          All tunable parameters
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/yourname/memecoins-trading-agent
cd memecoins-trading-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in:
- `HELIUS_API_KEY` — get at [helius.xyz](https://helius.xyz)
- `SOLANA_RPC_URL` — use Helius RPC for best performance
- `WALLET_PRIVATE_KEY` — base58 encoded private key of your trading wallet
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — create a bot via @BotFather
- `X_BEARER_TOKEN` or `GROK_API_KEY` — optional, enables CT scanning
- `DRY_RUN=true` — set this first to test without executing real trades

### 3. Add wallets to track

Edit `src/config/params.ts`:

```ts
export const TRACKED_WALLETS: string[] = [
  "wallet1addresshere",
  "wallet2addresshere",
  // ... 10-30 smart money wallets
];
```

Finding good wallets:
- Use [Cielo Finance](https://cielo.finance) to find consistent profitable wallets
- Filter for wallets with 30%+ win rate and consistent early entries
- Start with 10 wallets, expand as you verify track records

### 4. Test dry run

```bash
DRY_RUN=true npm run dev
```

Watch the logs. Add a few test wallet addresses that are actively trading.

### 5. Go live

```bash
npm run build
npm start
```

---

## Telegram Commands

Once running, message your bot:

| Command | Description |
|---|---|
| `/status` | SOL balance, open positions, win rate |
| `/positions` | All open positions with current multiplier |
| `/report` | Full performance report with adapted weights |

---

## Scoring System

Each token is scored 0-100 across four dimensions:

| Dimension | Default Weight | What it measures |
|---|---|---|
| Volume | 25% | 24h trading volume — too early or too late both penalized |
| Holders | 20% | Holder count — under 200 = too early, sweet spot 200-2000 |
| Dev | 30% | Dev wallet behavior — previous rugs are automatic 0 |
| Distribution | 25% | Top 10 holder concentration — above 70% is hard skip |

**Weights adapt** based on which dimensions actually predicted your wins. After 10+ trades, the learning engine shifts weights toward what's working.

### Position Sizing

| Wallets in | Base Size |
|---|---|
| 2 wallets | 15% of MAX SOL |
| 3 wallets | 35% of MAX SOL |
| 4 wallets | 60% of MAX SOL |
| 5 wallets | 100% of MAX SOL |

Size is then adjusted by composite score and wallet trust scores.

---

## Exit Strategy

Default staged exits:

| Trigger | Action |
|---|---|
| 2x | Sell 20% |
| 3x | Sell 30% (initial investment recovered) |
| 5x | Sell 30% |
| Remainder | Moon bag — rides until emergency exit or manual close |

**Emergency exits:**
- 2+ tracked wallets sell in 10 min window → sell 80%
- Stop loss at -40%
- Volume drops 70%+ in 15 min → sell 40%

---

## Learning Engine

After every closed trade, the agent:

1. **Adjusts score weights** — dimensions that predicted wins get higher weight
2. **Updates wallet trust** — wallets that called winners get trust boosts; wrong calls decay
3. **Logs pattern analysis** — wallet count win rates, CT motion effectiveness

Trust scores range from 0.0 to 2.0. Wallets below 0.5 trust won't trigger signals alone.

Minimum 10 closed trades before weight adaptation begins.

---

## Configuration

All parameters in `src/config/params.ts`:

```ts
MIN_WALLETS_FOR_SIGNAL: 2       // wallets needed to trigger
SIGNAL_WINDOW_SECONDS: 300      // 5 minute convergence window
MIN_SOL_BUY: 1                  // minimum position size
MAX_SOL_BUY: 10                 // maximum position size
MIN_COMPOSITE_SCORE: 60         // skip below this score
STOP_LOSS_PERCENT: -40          // exit if down 40%
DRY_RUN: false                  // simulate without executing
```

---

## Soul

This agent runs on a philosophy. Read `src/soul/SOUL.md` to understand its decision-making framework and `src/soul/PERSONALITY.md` for its voice and alert style.

The key principles:
- Smart money convergence is signal, CT is amplifier — never the other way
- Distribution tells the truth more than chart patterns
- Exits are mechanical — set the plan at entry, execute without emotion
- Every trade teaches something — the bot that doesn't adapt dies

---

## Important Disclaimers

- **This is experimental software.** Memecoin trading carries extreme risk of total loss.
- **Start with DRY_RUN=true** and paper trade for at least a week before going live.
- **Small position sizes first.** Run at MIN_SOL_BUY=0.1 initially.
- **You are responsible** for all trades executed by this agent.
- Not financial advice.

---

## License

MIT

---

*Built for the trenches.*
