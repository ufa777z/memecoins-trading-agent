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
  private signalCount = 0;

  constructor() {
    this.positionManager = new PositionManager(this.tokenAnalyzer, this.ctScanner);
    this.positionManager.setTradeExecutor(this.tradeExecutor);
  }

  async start(): Promise<void> {
    console.log('\n╔═══════════════════════════════════╗');
    console.log('║     TRENCH_AGENT v1.3.0           ║');
    console.log('╚═══════════════════════════════════╝\n');

    if (!PARAMS.MANUAL_MODE) {
      this.positionManager.loadFromDB();
    }
    this.setupEventHandlers();

    this.notifier.setupCommands({
      onStatus: () => this.getStatus(),
      onReport: () => this.learningEngine.generateReport(),
      onPositions: () => this.getPositionsMessage(),
    });

    this.walletTracker.start();
    if (!PARAMS.MANUAL_MODE) {
      this.positionManager.startMonitoring();
    }

    console.log(`[Orchestrator] Tracking ${this.walletTracker.getTrackedCount()} wallets`);
    console.log(`[Orchestrator] Mode: ${PARAMS.MANUAL_MODE ? 'MANUAL (alerts only)' : 'AUTO'}`);
    console.log(`[Orchestrator] Dry run: ${PARAMS.DRY_RUN}`);
    console.log(`[Orchestrator] CT scanner: ${PARAMS.ENABLE_CT_SCANNER}`);
    console.log('[Orchestrator] Ready — waiting for wallet convergence...\n');
  }

  private setupEventHandlers(): void {
    this.walletTracker.on('buy', async (event: WalletBuyEvent) => {
      if (!PARAMS.MANUAL_MODE) {
        this.positionManager.onTrackedWalletSell(event);
      }
      const signal = this.signalDetector.onBuyEvent(event);
      if (signal) await this.processSignal(signal);
    });

    if (PARAMS.MANUAL_MODE) return;

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
        this.positionManager.recordPartialExit(
          position.id,
          decision.percentToSell,
          result.outputAmount
        );

        if (position.remainingPercent - decision.percentToSell <= 5) {
          const pnlSol =
            result.outputAmount - position.entrySolAmount * (decision.percentToSell / 100);
          const pnlPct = position.entrySolAmount ? (position.currentMultiplier - 1) * 100 : 0;
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
      } else {
        console.error(`[Orchestrator] Exit failed:`, result.error);
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
        console.log(`  SKIP: ${score.failReasons[0] || 'filters'}`);
        if (PARAMS.NOTIFY_SKIPS) {
          await this.notifier.notifySkip(
            tokenAddress,
            score.symbol,
            score,
            score.failReasons[0] || 'failed filters'
          );
        }
        this.processingTokens.delete(tokenAddress);
        return;
      }

      let ctScore = 0;
      if (PARAMS.ENABLE_CT_SCANNER) {
        const ct = await this.ctScanner.scan(tokenAddress, score.symbol);
        ctScore = ct.motionScore;
        console.log(`  CT: ${ct.motionScore}/100 (${ct.trend}) — ${ct.summary}`);
      }

      const finalScore = Math.min(
        100,
        score.composite * (1 - PARAMS.CT_SCORE_WEIGHT) + ctScore * PARAMS.CT_SCORE_WEIGHT
      );

      if (finalScore < PARAMS.MIN_COMPOSITE_SCORE) {
        console.log(`  SKIP: final ${finalScore.toFixed(0)} < ${PARAMS.MIN_COMPOSITE_SCORE}`);
        if (PARAMS.NOTIFY_SKIPS) {
          await this.notifier.notifySkip(
            tokenAddress,
            score.symbol,
            score,
            `final ${finalScore.toFixed(0)} < ${PARAMS.MIN_COMPOSITE_SCORE}`
          );
        }
        this.processingTokens.delete(tokenAddress);
        return;
      }

      const suggestedSol = this.signalDetector.calculatePositionSize(signal, finalScore);
      this.signalCount += 1;

      // ── MANUAL MODE: alert only, never trade ───────────────────────────
      if (PARAMS.MANUAL_MODE) {
        TradeDB.insert({
          token_address: tokenAddress,
          token_symbol: score.symbol,
          entry_price: 0,
          entry_sol: 0,
          entry_time: Date.now(),
          status: 'signal_only',
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

        await this.notifier.notifySignalOnly(
          signal,
          score,
          finalScore,
          suggestedSol,
          ctScore
        );
        console.log(`  → MANUAL alert sent for $${score.symbol}`);
        return;
      }

      // ── AUTO path (only if MANUAL_MODE=false) ───────────────────────────
      const solBalance = await this.tradeExecutor.getSOLBalance();
      if (!PARAMS.DRY_RUN && solBalance < suggestedSol + 0.05) {
        console.log(`[Orchestrator] Insufficient SOL (${solBalance.toFixed(2)})`);
        return;
      }

      const result = await this.tradeExecutor.buy(tokenAddress, suggestedSol);
      if (!result.success) {
        console.error('[Orchestrator] Buy failed:', result.error);
        return;
      }

      let entryPrice = result.price;
      const dsPrice = await this.tradeExecutor.getTokenPriceSol(tokenAddress);
      if (dsPrice > 0) entryPrice = dsPrice;

      const tradeId = TradeDB.insert({
        token_address: tokenAddress,
        token_symbol: score.symbol,
        entry_price: entryPrice,
        entry_sol: suggestedSol,
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

      await this.notifier.notifyEntry(signal, score, suggestedSol, entryPrice, result.txHash);
    } finally {
      this.processingTokens.delete(tokenAddress);
    }
  }

  private async getStatus(): Promise<string> {
    const stats = TradeDB.stats();
    return [
      '*TRENCH_AGENT STATUS*',
      '',
      `Mode: ${PARAMS.MANUAL_MODE ? 'MANUAL (you buy)' : 'AUTO'}`,
      `Wallets tracked: ${this.walletTracker.getTrackedCount()}`,
      `Signals fired (this run): ${this.signalCount}`,
      `DB trades logged: ${stats.total}`,
      `Dry run: ${PARAMS.DRY_RUN}`,
    ].join('\n');
  }

  private async getPositionsMessage(): Promise<string> {
    if (PARAMS.MANUAL_MODE) {
      return 'Manual mode — no auto positions. Buy yourself when you get a SIGNAL.';
    }
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
