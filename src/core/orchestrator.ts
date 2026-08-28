import { WalletTracker, type WalletBuyEvent } from '../agents/walletTracker.js';
import { SignalDetector, type ConvergenceSignal } from '../agents/signalDetector.js';
import { TokenAnalyzer } from '../agents/tokenAnalyzer.js';
import { CTScanner } from '../agents/ctScanner.js';
import { TradeExecutor } from '../agents/tradeExecutor.js';
import { PositionManager } from '../agents/positionManager.js';
import { LearningEngine } from '../agents/learningEngine.js';
import { Notifier } from './notifier.js';
import { TradeDB } from '../data/db.js';
import { PARAMS } from '../config/params.js';

export class Orchestrator {
  private walletTracker = new WalletTracker();
  private signalDetector = new SignalDetector();
  private tokenAnalyzer = new TokenAnalyzer();
  private ctScanner = new CTScanner();
  private tradeExecutor = new TradeExecutor();
  private positionManager: PositionManager;
  private learningEngine = new LearningEngine();
  private notifier = new Notifier();
  private processingTokens = new Set<string>();

  constructor() {
    this.positionManager = new PositionManager(this.tokenAnalyzer, this.ctScanner);
  }

  async start(): Promise<void> {
    console.log('\n╔═══════════════════════════════════╗');
    console.log('║     TRENCH_AGENT v1.1.0           ║');
    console.log('╚═══════════════════════════════════╝\n');

    this.positionManager.loadFromDB();
    this.setupEventHandlers();

    this.notifier.setupCommands({
      onStatus: () => this.getStatus(),
      onReport: () => this.learningEngine.generateReport(),
      onPositions: () => this.getPositionsMessage(),
    });

    this.walletTracker.start();
    this.positionManager.startMonitoring();

    console.log(`[Orchestrator] Tracking ${this.walletTracker.getTrackedCount()} wallets`);
    console.log(`[Orchestrator] Dry run: ${PARAMS.DRY_RUN}`);
    console.log(`[Orchestrator] CT scanner: ${PARAMS.ENABLE_CT_SCANNER}`);
    console.log('[Orchestrator] Ready — waiting for signals...\n');
  }

  private setupEventHandlers(): void {
    this.walletTracker.on('buy', async (event: WalletBuyEvent) => {
      this.positionManager.onTrackedWalletSell(event);
      const signal = this.signalDetector.onBuyEvent(event);
      if (signal) await this.processSignal(signal);
    });

    this.positionManager.on('exit', async ({ position, decision }) => {
      if (!decision.shouldExit) return;
      console.log(`[Orchestrator] Exit ${position.symbol}: ${decision.reason}`);

      if (decision.reason === 'emergency') {
        await this.notifier.notifyEmergency(position, decision.message);
      }

      const result = await this.tradeExecutor.sell(position.tokenAddress, decision.percentToSell);
      if (result.success) {
        await this.notifier.notifyExit(
          position,
          decision.percentToSell,
          result.outputAmount,
          decision.message
        );
        this.positionManager.recordPartialExit(position.id, decision.percentToSell, result.outputAmount);

        if (position.remainingPercent - decision.percentToSell <= 5) {
          const pnlSol = result.outputAmount - position.entrySolAmount;
          const pnlPct = position.entrySolAmount
            ? (pnlSol / position.entrySolAmount) * 100
            : 0;
          TradeDB.updateExit(position.id, {
            exit_price: result.price,
            exit_sol: result.outputAmount,
            exit_time: Date.now(),
            pnl_sol: pnlSol,
            pnl_percent: pnlPct,
            status: 'closed',
            exit_reason: decision.reason,
          });
          const closed = TradeDB.getAll().find((t) => t.id === position.id);
          if (closed) await this.learningEngine.learn(closed);
          this.positionManager.closePosition(position.id);
        }
      }
    });

    this.positionManager.on('ctMotion', async ({ position, ctSignal }) => {
      await this.notifier.notifyCTMotion(position, ctSignal);
    });
  }

  private async processSignal(signal: ConvergenceSignal): Promise<void> {
    const { tokenAddress } = signal;
    if (this.processingTokens.has(tokenAddress)) return;
    this.processingTokens.add(tokenAddress);

    try {
      console.log(`\n[Orchestrator] Signal ${tokenAddress.slice(0, 8)}… wallets=${signal.walletCount}`);

      const score = await this.tokenAnalyzer.score(tokenAddress);
      if (!score) {
        this.processingTokens.delete(tokenAddress);
        return;
      }

      if (!score.pass) {
        await this.notifier.notifySkip(tokenAddress, score.symbol, score, score.failReasons[0] || 'failed filters');
        this.processingTokens.delete(tokenAddress);
        return;
      }

      let ctScore = 0;
      if (PARAMS.ENABLE_CT_SCANNER) {
        const ct = await this.ctScanner.scan(tokenAddress, score.symbol);
        ctScore = ct.motionScore;
        console.log(`  CT: ${ct.motionScore}/100 (${ct.trend}) — ${ct.summary}`);
      }

      // CT is amplifier only (SOUL.md)
      const finalScore = Math.min(
        100,
        score.composite * (1 - PARAMS.CT_SCORE_WEIGHT) + ctScore * PARAMS.CT_SCORE_WEIGHT
      );

      if (finalScore < PARAMS.MIN_COMPOSITE_SCORE) {
        await this.notifier.notifySkip(
          tokenAddress,
          score.symbol,
          score,
          `final ${finalScore.toFixed(0)} < ${PARAMS.MIN_COMPOSITE_SCORE}`
        );
        this.processingTokens.delete(tokenAddress);
        return;
      }

      const positionSol = this.signalDetector.calculatePositionSize(signal, finalScore);
      const solBalance = await this.tradeExecutor.getSOLBalance();
      if (!PARAMS.DRY_RUN && solBalance < positionSol + 0.05) {
        console.log(`[Orchestrator] Insufficient SOL (${solBalance.toFixed(2)})`);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      const result = await this.tradeExecutor.buy(tokenAddress, positionSol);
      if (!result.success) {
        console.error('[Orchestrator] Buy failed:', result.error);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      const tradeId = TradeDB.insert({
        token_address: tokenAddress,
        token_symbol: score.symbol,
        entry_price: result.price,
        entry_sol: positionSol,
        entry_time: Date.now(),
        status: 'open',
        signal_wallets: JSON.stringify(signal.wallets),
        wallet_count: signal.walletCount,
        composite_score: finalScore,
        score_volume: score.volume,
        score_holders: score.holders,
        score_dev: score.dev,
        score_distribution: score.distribution,
        score_ct: ctScore,
        ct_motion: ctScore > 50 ? 1 : 0,
      });

      const trade = TradeDB.getAll().find((t) => t.id === tradeId);
      if (trade) this.positionManager.addPosition(trade, signal.wallets);

      await this.notifier.notifyEntry(signal, score, positionSol, result.price, result.txHash);
    } finally {
      this.processingTokens.delete(tokenAddress);
    }
  }

  private async getStatus(): Promise<string> {
    const stats = TradeDB.stats();
    const open = this.positionManager.getAll();
    const sol = await this.tradeExecutor.getSOLBalance().catch(() => 0);
    return [
      '*TRENCH_AGENT STATUS*',
      '',
      `SOL: ${sol.toFixed(3)}`,
      `Open: ${open.length}`,
      `Wallets: ${this.walletTracker.getTrackedCount()}`,
      `Trades: ${stats.total} | WR ${stats.winRate}% | PnL ${stats.totalPnl} SOL`,
      `Dry run: ${PARAMS.DRY_RUN}`,
    ].join('\n');
  }

  private async getPositionsMessage(): Promise<string> {
    const positions = this.positionManager.getAll();
    if (!positions.length) return 'No open positions.';
    return positions
      .map(
        (p) =>
          `*$${p.symbol}* ${p.currentMultiplier.toFixed(2)}x | rem ${p.remainingPercent}% | CT ${p.ctMotionDetected ? 'yes' : 'no'}`
      )
      .join('\n');
  }

  async stop(): Promise<void> {
    this.walletTracker.stop();
    this.positionManager.stopMonitoring();
    this.signalDetector.destroy();
  }
}
