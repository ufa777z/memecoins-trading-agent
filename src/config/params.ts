import 'dotenv/config';

/**
 * All tunable parameters.
 * Philosophy: smart money = signal, CT = amplifier only.
 */
export const PARAMS = {
  // ── Signal ──────────────────────────────────────────────────────────────
  /** Minimum distinct tracked wallets that must buy the same token */
  MIN_WALLETS_FOR_SIGNAL: 3,
  /** Convergence window in seconds (default 5 min) */
  SIGNAL_WINDOW_SECONDS: 300,

  // ── Sizing ──────────────────────────────────────────────────────────────
  MIN_SOL_BUY: 0.5,
  MAX_SOL_BUY: 5,
  /** Skip if final composite below this */
  MIN_COMPOSITE_SCORE: 65,

  // ── Scoring weights (adapt via learning engine after 10+ trades) ───────
  WEIGHT_VOLUME: 0.25,
  WEIGHT_HOLDERS: 0.20,
  WEIGHT_DEV: 0.30,
  WEIGHT_DISTRIBUTION: 0.25,
  /** CT contributes at most this fraction of the final score (amplifier) */
  CT_SCORE_WEIGHT: 0.15,

  // ── Hard filters ────────────────────────────────────────────────────────
  MAX_TOP10_HOLDER_PCT: 55,
  MIN_HOLDERS: 150,
  MAX_HOLDERS_LATE: 8000,

  // ── Exits ───────────────────────────────────────────────────────────────
  STOP_LOSS_PERCENT: -35,
  TAKE_PROFITS: [
    { multiple: 2, sellPct: 20 },
    { multiple: 3, sellPct: 30 },
    { multiple: 5, sellPct: 30 },
  ] as { multiple: number; sellPct: number }[],
  EMERGENCY_WALLET_SELL_COUNT: 2,
  EMERGENCY_WALLET_WINDOW_SEC: 600,
  VOLUME_DROP_PCT: 70,
  VOLUME_DROP_WINDOW_SEC: 900,

  // ── CT scanner ──────────────────────────────────────────────────────────
  ENABLE_CT_SCANNER: process.env.ENABLE_CT_SCANNER !== 'false',
  CT_LOOKBACK_MINUTES: 45,
  CT_MIN_MENTIONS_FOR_SIGNAL: 3,
  CT_VELOCITY_SPIKE_RATIO: 2.5,

  // ── Infra ───────────────────────────────────────────────────────────────
  DRY_RUN: process.env.DRY_RUN !== 'false',
  HELIUS_WS_URL:
    process.env.HELIUS_WS_URL ||
    `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || '',
  SLIPPAGE_BPS: 300,
  PRIORITY_FEE_SOL: 0.0001,
} as const;

/**
 * Smart money wallets to track.
 * Source these from Cielo / GMGN / your own PnL research.
 * Prefer 30%+ win rate, early entries, consistent size.
 */
export const TRACKED_WALLETS: string[] = [
  // Add 10–30 addresses here
  // "WalletPubkey1...",
  // "WalletPubkey2...",
];

/** Optional: high-signal CT accounts (handles without @). Mentions from these weigh more. */
export const CT_PRIORITY_ACCOUNTS: string[] = [
  // "ansem", "trader name", etc. — keep short and high quality
];
