import { EventEmitter } from 'events';
import { PARAMS } from '../config/params.js';
import type { TokenAnalyzer } from './tokenAnalyzer.js';
import type { CTScanner, CTSignal } from './ctScanner.js';
import type { Trade } from '../data/db.js';

export interface Position {
  id: number;
  tokenAddress: string;
  symbol: string;
  entrySolAmount: number;
  entryPrice: number;
  remainingPercent: number;
  currentMultiplier: number;
  highWaterMark: number;
  signalWallets: string[];
  ctMotionDetected: boolean;
  openedAt: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  percentToSell: number;
  reason: string;
  message: string;
}

export class PositionManager extends EventEmitter {
  private positions: Map<number, Position> = new Map();
  private monitorTimer: NodeJS.Timeout | null = null;
  private recentWalletSells: Map<string, { wallet: string; ts: number }[]> = new Map();

  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private ctScanner: CTScanner
  ) {
    super();
  }

  loadFromDB(): void {
    // Hook for resuming open trades from SQLite
  }

  addPosition(trade: Trade, wallets: string[]): void {
    const pos: Position = {
      id: trade.id!,
      tokenAddress: trade.token_address,
      symbol: trade.token_symbol,
      entrySolAmount: trade.entry_sol,
      entryPrice: trade.entry_price,
      remainingPercent: 100,
      currentMultiplier: 1,
      highWaterMark: 1,
      signalWallets: wallets,
      ctMotionDetected: false,
      openedAt: trade.entry_time,
    };
    this.positions.set(pos.id, pos);
  }

  getAll(): Position[] {
    return [...this.positions.values()];
  }

  startMonitoring(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this.tick(), 20_000);
  }

  stopMonitoring(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
  }

  onTrackedWalletSell(event: { wallet: string; tokenAddress: string; timestamp: number }): void {
    for (const pos of this.positions.values()) {
      if (pos.tokenAddress !== event.tokenAddress) continue;
      if (!pos.signalWallets.includes(event.wallet)) continue;

      const list = this.recentWalletSells.get(pos.tokenAddress) || [];
      list.push({ wallet: event.wallet, ts: event.timestamp });
      const cutoff = event.timestamp - PARAMS.EMERGENCY_WALLET_WINDOW_SEC * 1000;
      const recent = list.filter((x) => x.ts >= cutoff);
      this.recentWalletSells.set(pos.tokenAddress, recent);

      const unique = new Set(recent.map((x) => x.wallet));
      if (unique.size >= PARAMS.EMERGENCY_WALLET_SELL_COUNT) {
        this.emit('exit', {
          position: pos,
          decision: {
            shouldExit: true,
            percentToSell: 80,
            reason: 'emergency',
            message: `${unique.size} tracked wallets sold within window`,
          } as ExitDecision,
        });
      }
    }
  }

  recordPartialExit(id: number, percent: number, _solOut: number): void {
    const pos = this.positions.get(id);
    if (!pos) return;
    pos.remainingPercent = Math.max(0, pos.remainingPercent - percent);
  }

  closePosition(id: number): void {
    this.positions.delete(id);
  }

  private async tick(): Promise<void> {
    for (const pos of this.positions.values()) {
      // Staged TP based on multiplier — real price feed should update currentMultiplier
      for (const tp of PARAMS.TAKE_PROFITS) {
        if (pos.currentMultiplier >= tp.multiple && pos.remainingPercent > 20) {
          // Fire once per level would need state flags; simplified emit
          this.emit('exit', {
            position: pos,
            decision: {
              shouldExit: true,
              percentToSell: tp.sellPct,
              reason: `tp_${tp.multiple}x`,
              message: `Take profit ${tp.multiple}x — sell ${tp.sellPct}%`,
            } as ExitDecision,
          });
          break;
        }
      }

      if (pos.currentMultiplier <= 1 + PARAMS.STOP_LOSS_PERCENT / 100) {
        this.emit('exit', {
          position: pos,
          decision: {
            shouldExit: true,
            percentToSell: 100,
            reason: 'stop_loss',
            message: `Stop loss at ${PARAMS.STOP_LOSS_PERCENT}%`,
          } as ExitDecision,
        });
      }

      // Optional CT refresh on open positions
      if (PARAMS.ENABLE_CT_SCANNER) {
        try {
          const ct = await this.ctScanner.scan(pos.tokenAddress, pos.symbol);
          if (ct.trend === 'exploding' || ct.trend === 'rising') {
            pos.ctMotionDetected = true;
            this.emit('ctMotion', { position: pos, ctSignal: ct });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
}
