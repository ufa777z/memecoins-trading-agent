import 'dotenv/config';

/**
 * All tunable parameters.
 * Philosophy: smart money = signal, CT = amplifier only.
 */
export const PARAMS = {
  MIN_WALLETS_FOR_SIGNAL: 3,
  SIGNAL_WINDOW_SECONDS: 300,

  MIN_SOL_BUY: 0.5,
  MAX_SOL_BUY: 5,
  MIN_COMPOSITE_SCORE: 65,

  WEIGHT_VOLUME: 0.25,
  WEIGHT_HOLDERS: 0.20,
  WEIGHT_DEV: 0.30,
  WEIGHT_DISTRIBUTION: 0.25,
  CT_SCORE_WEIGHT: 0.15,

  MAX_TOP10_HOLDER_PCT: 55,
  MIN_HOLDERS: 150,
  MAX_HOLDERS_LATE: 8000,

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

  ENABLE_CT_SCANNER: process.env.ENABLE_CT_SCANNER !== 'false',
  CT_LOOKBACK_MINUTES: 45,
  CT_MIN_MENTIONS_FOR_SIGNAL: 3,
  CT_VELOCITY_SPIKE_RATIO: 2.5,

  DRY_RUN: process.env.DRY_RUN !== 'false',
  HELIUS_WS_URL:
    process.env.HELIUS_WS_URL ||
    `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`,
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || '',
  SLIPPAGE_BPS: 300,
  PRIORITY_FEE_SOL: 0.0001,
} as const;

/**
 * Smart money wallets (public leaderboards: KOL Explorer / kolscan / Subglow).
 * Snapshot ~May–Aug 2026 — RE-VALIDATE on GMGN/Cielo before live size.
 * Prefer high trade count + positive realized PnL; avoid one-hit wonders.
 */
export const TRACKED_WALLETS: string[] = [
  // --- Core KOLs (repeated top ranks) ---
  'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', // Cented
  'Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt', // Theo
  '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9', // Decu
  '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f', // Cupsey
  '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk', // Jijo
  'BTf4A2exGK9BCVDNzy65b9dUzXgMqB4weVkvTMFQsadd', // Kev
  'Av3xWHJ5EsoLZag6pr7LKbrGgLRTaykXomDD5kBhL9YQ', // Heyitsyolo
  'G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC', // Clukz
  'BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd', // Dv
  '8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR', // Casino

  // --- Subglow / kolscan 30d leaders ---
  '78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2', // Sheep
  'Dgehc8YMv6dHsiPJVoumvq4pSBkMVvrTgTUg7wdcYJPJ', // omar
  '6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC', // Nyhrox
  'J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa', // Pain
  'JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN', // West
  '5ZuV8eqkvzYFVEKbLvGBdexL2tFv7E5BCd2HZpjqbdg', // Doji
  '6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2', // LJC
  '215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP', // OGAntD
  'HYSq1KBAvqWpEv1pCbV31muKM1za5A1WSHGdiVLUoNhb', // Apex
  'DemfvB4iwd3NmVquvWqWbB92yVZWFFqybqBeJGdyEeM6', // japbitch

  // --- More documented profitable ---
  '4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu', // Rilsio
  '8nqtxpFpuXwfXG4pBLsDkkuMMPK9FjSkBMCn542HiM3v', // dov
  'DAEdBmTPEKM6xkwfzC3d411QUe6coKpkND6UURa4CvHC', // Fox
  '2X4H5Y9C4Fy6Pf3wpq8Q4gMvLcWvfrrwDv2bdR8AAwQv', // Orange
  'DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s', // LUKEY
  'GfXQesPe3Zuwg8JhAt6Cg8euJDTVx751enp9EQQmhzPH', // Spuno
  '5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM', // Schoen

  // --- Dune recent high-WR / PnL samples (re-check before relying) ---
  'HCsfJh2qfGtsoJ9hkhBLyF84YMLFWFUcnTcKEZNtiFsW',
  '4oLKsFMzB6ttQDsDgKeNKWB6V8uHAQ8vtNQLxbfKVWwA',
  '7uPxCfh1cygSo1sx1rsHyxjdxyyR9hbucsLDvbeN26Hf',
];

/** Optional high-signal CT handles (no @) */
export const CT_PRIORITY_ACCOUNTS: string[] = [];
