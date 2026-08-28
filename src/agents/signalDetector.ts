import { EventEmitter } from 'events';
import { PARAMS } from '../config/params.js';
import type { WalletBuyEvent } from './walletTracker.js';

export interface ConvergenceSignal {
  tokenAddress: string;
  wallets: string[];
  walletCount: number;
  weightedTrust: number;
  firstSeen: number;
  lastSeen: number;
  totalSol: number;
}

interface TokenBucket {
  wallets: Map<string, { sol: number; ts: number; trust: number }>;
  firstSeen: number;
}

/**
 * Detects when N tracked wallets buy the same token within SIGNAL_WINDOW_SECONDS.
 */
export class SignalDetector extends EventEmitter {
  private buckets: Map<string, TokenBucket> = new Map();
  private emitted: Set<string> = new Set();
  private trustScores: Map<string, number> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    super();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  setTrust(wallet: string, trust: number): void {
    this.trustScores.set(wallet, Math.max(0, Math.min(2, trust)));
  }

  getTrust(wallet: string): number {
    return this.trustScores.get(wallet) ?? 1.0;
  }

  onBuyEvent(event: WalletBuyEvent): ConvergenceSignal | null {
    const trust = this.getTrust(event.wallet);
    if (trust < 0.5) return null; // low-trust wallets never trigger alone or in clusters

    let bucket = this.buckets.get(event.tokenAddress);
    if (!bucket) {
      bucket = { wallets: new Map(), firstSeen: event.timestamp };
      this.buckets.set(event.tokenAddress, bucket);
    }

    bucket.wallets.set(event.wallet, {
      sol: event.solAmount,
      ts: event.timestamp,
      trust,
    });

    // Drop stale wallets outside window
    const cutoff = event.timestamp - PARAMS.SIGNAL_WINDOW_SECONDS * 1000;
    for (const [w, info] of bucket.wallets) {
      if (info.ts < cutoff) bucket.wallets.delete(w);
    }

    const walletCount = bucket.wallets.size;
    if (walletCount < PARAMS.MIN_WALLETS_FOR_SIGNAL) return null;

    // One signal per token per window
    const key = `${event.tokenAddress}:${bucket.firstSeen}`;
    if (this.emitted.has(key)) return null;
    this.emitted.add(key);

    const wallets = [...bucket.wallets.keys()];
    const weightedTrust =
      [...bucket.wallets.values()].reduce((s, v) => s + v.trust, 0) / walletCount;
    const totalSol = [...bucket.wallets.values()].reduce((s, v) => s + v.sol, 0);
    const lastSeen = Math.max(...[...bucket.wallets.values()].map((v) => v.ts));

    const signal: ConvergenceSignal = {
      tokenAddress: event.tokenAddress,
      wallets,
      walletCount,
      weightedTrust,
      firstSeen: bucket.firstSeen,
      lastSeen,
      totalSol,
    };

    this.emit('signal', signal);
    return signal;
  }

  /**
   * Position size from wallet count × score × trust (capped by MAX_SOL_BUY).
   */
  calculatePositionSize(signal: ConvergenceSignal, compositeScore: number): number {
    const basePct =
      signal.walletCount >= 5
        ? 1.0
        : signal.walletCount === 4
          ? 0.6
          : signal.walletCount === 3
            ? 0.35
            : 0.15;

    const scoreMult = Math.max(0.4, Math.min(1.2, compositeScore / 80));
    const trustMult = Math.max(0.5, Math.min(1.3, signal.weightedTrust));

    let sol = PARAMS.MAX_SOL_BUY * basePct * scoreMult * trustMult;
    sol = Math.max(PARAMS.MIN_SOL_BUY, Math.min(PARAMS.MAX_SOL_BUY, sol));
    return Math.round(sol * 1000) / 1000;
  }

  private cleanup(): void {
    const cutoff = Date.now() - PARAMS.SIGNAL_WINDOW_SECONDS * 1000 * 3;
    for (const [token, bucket] of this.buckets) {
      if (bucket.firstSeen < cutoff) this.buckets.delete(token);
    }
    // Trim emitted set
    if (this.emitted.size > 5000) this.emitted.clear();
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
    this.emitted.clear();
  }
}
