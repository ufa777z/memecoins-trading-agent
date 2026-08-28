import { EventEmitter } from 'events';
import { PARAMS } from '../config/params.js';
import type { TokenAnalyzer } from './tokenAnalyzer.js';
import type { CTScanner } from './ctScanner.js';
import type { TradeExecutor } from './tradeExecutor.js';
import { TradeDB, type Trade } from '../data/db.js';

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
  hitTp: Set<number>;
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
  private tradeExecutor: TradeExecutor | null = null;

  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private ctScanner: CTScanner
  ) {
    super();
  }

  setTradeExecutor(exec: TradeExecutor): void {
    this.tradeExecutor = exec;
  }

  loadFromDB(): void {
    const open = TradeDB.getAll().filter((t) => t.status === 'open');
    for (const t of open) {
      let wallets: string[] = [];
      try {
        wallets = JSON.parse(t.signal_wallets || '[]');
      } catch {
        /* */
      }
      this.addPosition(t, wallets);
    }
    if (open.length) console.log(`[PositionManager] Restored ${open.length} open positions`);
  }

  addPosition(trade: Trade, wallets: string[]): void {
    if (this.positions.has(trade.id!)) return;
    const pos: Position = {
      id: trade.id!,
      tokenAddress: trade.token_address,
      symbol: trade.token_symbol,
      entrySolAmount: trade.entry_sol,
      entryPrice: trade.entry_price || 0,
      remainingPercent: 100,
      currentMultiplier: 1,
      highWaterMark: 1,
      signalWallets: wallets,
      ctMotionDetected: false,
      openedAt: trade.entry_time,
      hitTp: new Set(),
    };
    this.positions.set(pos.id, pos);
  }

  getAll(): Position[] {
    return [...this.positions.values()];
  }

  startMonitoring(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => void this.tick(), 15_000);
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
      // Mark-to-market
      if (this.tradeExecutor) {
        const px = await this.tradeExecutor.getTokenPriceSol(pos.tokenAddress);
        if (px > 0 && pos.entryPrice > 0) {
          pos.currentMultiplier = px / pos.entryPrice;
          pos.highWaterMark = Math.max(pos.highWaterMark, pos.currentMultiplier);
        } else if (px > 0 && pos.entryPrice === 0) {
          // entry price unknown (dry run) — skip mult
        }
      }

      for (const tp of PARAMS.TAKE_PROFITS) {
        if (
          pos.currentMultiplier >= tp.multiple &&
          !pos.hitTp.has(tp.multiple) &&
          pos.remainingPercent > 15
        ) {
          pos.hitTp.add(tp.multiple);
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

      if (pos.currentMultiplier > 0 && pos.currentMultiplier <= 1 + PARAMS.STOP_LOSS_PERCENT / 100) {
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
