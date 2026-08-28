# Memecoins trading agent (TRENCH_AGENT v1.1)

> Autonomous Solana memecoin agent. **Smart wallets = signal. CT = amplifier only.**

Fork of thegreatola architecture, rebuilt with a full `src/` tree, safer defaults, and an enhanced Crypto Twitter scanner (Grok / X API).

---

## Winning formula

1. **≥3** tracked high-trust wallets buy the same token within ~5 minutes  
2. Token passes volume / holders / distribution / liquidity gates  
3. CT velocity + organic quality used **only as a boost** (≤15% of final score)  
4. Size by wallet count × composite score × wallet trust  
5. Staged exits at 2x / 3x / 5x + emergency if tracked wallets dump  

You never buy *because* CT is loud. You buy because wallets moved and CT may be catching up.

---

## Architecture

```
src/
├── agents/
│   ├── walletTracker.ts      Helius WebSocket — tracked wallets
│   ├── signalDetector.ts     Convergence (min 3 wallets default)
│   ├── tokenAnalyzer.ts      DexScreener scoring + hard filters
│   ├── ctScanner.ts          Grok / X CT velocity + organic quality
│   ├── tradeExecutor.ts      Jupiter swaps (DRY_RUN first)
│   ├── positionManager.ts    TP ladder, stop, emergency exits
│   └── learningEngine.ts     Wallet trust updates after closes
├── core/
│   ├── orchestrator.ts       Wires the pipeline
│   └── notifier.ts           Telegram (minimal, PERSONALITY style)
├── config/params.ts          All tunables + TRACKED_WALLETS
├── data/db.ts                SQLite trades + trust
├── soul/SOUL.md
└── index.ts
```

---

## Setup

```bash
git clone https://github.com/ufa777z/memecoins-trading-agent.git
cd memecoins-trading-agent
npm install
cp .env.example .env
```

Fill `.env`:

| Variable | Purpose |
|----------|---------|
| `HELIUS_API_KEY` | RPC + WebSocket |
| `SOLANA_RPC_URL` / `HELIUS_WS_URL` | Prefer Helius endpoints |
| `WALLET_PRIVATE_KEY` | Dedicated low-balance trading wallet (base58) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Alerts |
| `GROK_API_KEY` or `X_BEARER_TOKEN` | CT scanner |
| `DRY_RUN=true` | **Keep true until verified** |

Edit `src/config/params.ts` → `TRACKED_WALLETS` (10–30 wallets from Cielo/GMGN; prefer 30%+ win rate, early entries).

```bash
npm run dev          # DRY_RUN by default
npm run build && npm start
```

---

## CT scanner (v1.1)

- **Grok** (preferred): semantic narrative, velocity, organic vs spam  
- **X API** fallback: recent search + heuristics  
- Outputs `motionScore`, `trend`, `organicScore`, `velocityRatio`  
- Orchestrator mixes CT at `CT_SCORE_WEIGHT` (default **0.15**) only  

---

## Defaults (safer than original README)

| Param | Value |
|-------|--------|
| `MIN_WALLETS_FOR_SIGNAL` | **3** |
| `MIN_COMPOSITE_SCORE` | **65** |
| `MAX_SOL_BUY` | **5** |
| `STOP_LOSS_PERCENT` | **-35** |
| `DRY_RUN` | **true** unless env sets otherwise |

---

## Telegram

| Command | Description |
|---------|-------------|
| `/status` | Balance, open positions, win rate |
| `/positions` | Open positions |
| `/report` | Simple performance report |

---

## Disclaimers

- Experimental. Memecoins can go to zero.  
- Start in `DRY_RUN`, tiny size, dedicated wallet.  
- You are responsible for all trades and keys.  
- Not financial advice.  

MIT — *Built for the trenches.*
