import { TradeDB, type Trade } from '../data/db.js';

/**
 * After closed trades: adjust wallet trust and log pattern notes.
 * Full weight adaptation kicks in after 10+ closed trades.
 */
export class LearningEngine {
  async learn(trade: Trade): Promise<void> {
    const win = (trade.pnl_sol ?? 0) > 0;
    try {
      const wallets: string[] = JSON.parse(trade.signal_wallets || '[]');
      for (const w of wallets) {
        const current = TradeDB.getWalletTrust(w);
        const next = win
          ? Math.min(2, current + 0.05)
          : Math.max(0, current - 0.08);
        TradeDB.setWalletTrust(w, next);
      }
      console.log(
        `[Learning] Trade #${trade.id} ${win ? 'WIN' : 'LOSS'} ${trade.pnl_percent?.toFixed(1)}% — updated ${wallets.length} wallet trusts`
      );
    } catch (err) {
      console.error('[Learning]', (err as Error).message);
    }
  }

  async generateReport(): Promise<string> {
    const stats = TradeDB.stats();
    return [
      '*TRENCH_AGENT REPORT*',
      '',
      `Trades: ${stats.total}`,
      `Win rate: ${stats.winRate}%`,
      `Total P&L: ${stats.totalPnl} SOL`,
      '',
      'Weights adapt after 10+ closed trades.',
      'CT remains amplifier only — smart money is primary.',
    ].join('\n');
  }
}
