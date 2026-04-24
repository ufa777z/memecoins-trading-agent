import { WalletTracker, WalletBuyEvent } from '../agents/walletTracker';
import { SignalDetector, ConvergenceSignal } from '../agents/signalDetector';
import { TokenAnalyzer } from '../agents/tokenAnalyzer';
import { CTScanner } from '../agents/ctScanner';
import { TradeExecutor } from '../agents/tradeExecutor';
import { PositionManager } from '../agents/positionManager';
import { LearningEngine } from '../agents/learningEngine';
import { Notifier } from './notifier';
import { TradeDB, Trade } from '../data/db';
import { PARAMS } from '../config/params';

export class Orchestrator {
  private walletTracker: WalletTracker;
  private signalDetector: SignalDetector;
  private tokenAnalyzer: TokenAnalyzer;
  private ctScanner: CTScanner;
  private tradeExecutor: TradeExecutor;
  private positionManager: PositionManager;
  private learningEngine: LearningEngine;
  private notifier: Notifier;

  // In-flight token addresses to avoid duplicate processing
  private processingTokens: Set<string> = new Set();

  constructor() {
    this.walletTracker = new WalletTracker();
    this.signalDetector = new SignalDetector();
    this.tokenAnalyzer = new TokenAnalyzer();
    this.ctScanner = new CTScanner();
    this.tradeExecutor = new TradeExecutor();
    this.positionManager = new PositionManager(this.tokenAnalyzer, this.ctScanner);
    this.learningEngine = new LearningEngine();
    this.notifier = new Notifier();
  }

  async start(): Promise<void> {
    console.log('\n╔═══════════════════════════════════╗');
    console.log('║       TRENCH_AGENT v1.0.0          ║');
    console.log('╚═══════════════════════════════════╝\n');

    // Load open positions from DB (resume after restart)
    this.positionManager.loadFromDB();

    // Wire up event handlers
    this.setupEventHandlers();

    // Setup Telegram command handlers
    this.notifier.setupCommands({
      onStatus: () => this.getStatus(),
      onReport: async () => this.learningEngine.generateReport(),
      onPositions: () => this.getPositionsMessage(),
    });

    // Start wallet tracker
    this.walletTracker.start();

    // Start position monitoring
    this.positionManager.startMonitoring();

    console.log(`[Orchestrator] Running. Tracking ${this.walletTracker.getTrackedCount()} wallets.`);
    console.log(`[Orchestrator] Dry run: ${PARAMS.DRY_RUN}`);
    console.log('[Orchestrator] Ready — waiting for signals...\n');
  }

  private setupEventHandlers(): void {
    // ── Wallet buy events ──────────────────────────────────────────────────
    this.walletTracker.on('buy', async (event: WalletBuyEvent) => {
      // Check if this might be a SELL from a tracked wallet we hold
      // (detected when same wallet sells a token we have open)
      this.positionManager.onTrackedWalletSell(event);

      // Feed into signal detector
      const signal = this.signalDetector.onBuyEvent(event);
      if (signal) {
        await this.processSignal(signal);
      }
    });

    // ── Exit signals from position manager ────────────────────────────────
    this.positionManager.on('exit', async ({ position, decision }) => {
      if (!decision.shouldExit) return;

      console.log(`[Orchestrator] Exit triggered for ${position.symbol}: ${decision.reason}`);

      if (decision.reason === 'emergency') {
        await this.notifier.notifyEmergency(position, decision.message);
      }

      const result = await this.tradeExecutor.sell(position.tokenAddress, decision.percentToSell);

      if (result.success) {
        await this.notifier.notifyExit(position, decision.percentToSell, result.outputAmount, decision.message);

        // Update position
        this.positionManager.recordPartialExit(position.id, decision.percentToSell, result.outputAmount);

        // If fully exited, update DB and run learning
        const remaining = position.remainingPercent - decision.percentToSell;
        if (remaining <= 5) {
          const pnlSol = result.outputAmount - position.entrySolAmount;
          const pnlPct = (pnlSol / position.entrySolAmount) * 100;

          TradeDB.updateExit(position.id, {
            exit_price: result.price,
            exit_sol: result.outputAmount,
            exit_time: Date.now(),
            pnl_sol: pnlSol,
            pnl_percent: pnlPct,
            status: 'closed',
            exit_reason: decision.reason,
          });

          // Run learning engine
          const closedTrade = TradeDB.getAll().find(t => t.id === position.id);
          if (closedTrade) {
            await this.learningEngine.learn(closedTrade);
          }

          this.positionManager.closePosition(position.id);
          console.log(`[Orchestrator] Position #${position.id} fully closed. P&L: ${pnlSol.toFixed(3)} SOL`);
        }
      } else {
        console.error(`[Orchestrator] Exit failed for ${position.symbol}:`, result.error);
      }
    });

    // ── CT motion on existing position ────────────────────────────────────
    this.positionManager.on('ctMotion', async ({ position, ctSignal }) => {
      console.log(`[Orchestrator] CT motion detected on held position ${position.symbol}`);
      await this.notifier.notifyCTMotion(position, ctSignal);

      // If CT is exploding and we're already up 2x+, consider adding
      if (ctSignal.trend === 'exploding' && position.currentMultiplier >= 2.0) {
        const additionalSol = PARAMS.MIN_SOL_BUY;
        console.log(`[Orchestrator] Adding ${additionalSol} SOL to ${position.symbol} (CT exploding)`);
        await this.tradeExecutor.buy(position.tokenAddress, additionalSol);
      }
    });
  }

  /**
   * Main signal processing pipeline:
   * signal → score → CT check → size → execute → notify
   */
  private async processSignal(signal: ConvergenceSignal): Promise<void> {
    const { tokenAddress } = signal;

    // Prevent duplicate processing
    if (this.processingTokens.has(tokenAddress)) return;
    this.processingTokens.add(tokenAddress);

    try {
      console.log(`\n[Orchestrator] Processing signal for ${tokenAddress}`);
      console.log(`  Wallets: ${signal.walletCount}, Trust: ${signal.weightedTrust.toFixed(2)}`);

      // Step 1: Score the token
      const score = await this.tokenAnalyzer.score(tokenAddress);
      if (!score) {
        console.log('[Orchestrator] Could not score token — skipping');
        this.processingTokens.delete(tokenAddress);
        return;
      }

      console.log(`  Score: ${score.composite}/100 (vol:${score.volume} hold:${score.holders} dev:${score.dev} dist:${score.distribution})`);

      // Step 2: Hard fails
      if (!score.pass) {
        console.log(`  SKIP: ${score.failReasons[0]}`);
        await this.notifier.notifySkip(tokenAddress, score.symbol, score, score.failReasons[0]);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      // Step 3: CT scan (async, doesn't block entry if disabled)
      let ctScore = 0;
      if (PARAMS.ENABLE_CT_SCANNER === true || process.env.ENABLE_CT_SCANNER === 'true') {
        const ct = await this.ctScanner.scan(tokenAddress, score.symbol);
        ctScore = ct.motionScore;
        console.log(`  CT: ${ct.motionScore}/100 (${ct.trend}, ${ct.mentionCount} mentions)`);
      }

      // Step 4: Final composite with CT bonus
      const finalScore = Math.min(100, score.composite + ctScore * 0.1);

      if (finalScore < PARAMS.MIN_COMPOSITE_SCORE) {
        await this.notifier.notifySkip(tokenAddress, score.symbol, score, `final score ${finalScore.toFixed(0)}/100 below threshold`);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      // Step 5: Size position
      const positionSol = this.signalDetector.calculatePositionSize(signal, finalScore);

      // Check SOL balance
      const solBalance = await this.tradeExecutor.getSOLBalance();
      if (solBalance < positionSol + 0.1) {
        console.log(`[Orchestrator] Insufficient SOL balance (${solBalance.toFixed(2)} SOL, need ${positionSol})`);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      // Step 6: Execute buy
      const result = await this.tradeExecutor.buy(tokenAddress, positionSol);
      if (!result.success) {
        console.error(`[Orchestrator] Buy failed:`, result.error);
        this.processingTokens.delete(tokenAddress);
        return;
      }

      console.log(`  ENTERED: ${positionSol} SOL @ ${result.price.toFixed(8)}`);

      // Step 7: Record in DB
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

      // Step 8: Track position
      const trade = TradeDB.getAll().find(t => t.id === tradeId);
      if (trade) {
        this.positionManager.addPosition(trade, signal.wallets);
      }

      // Step 9: Notify
      await this.notifier.notifyEntry(signal, score, positionSol, result.price, result.txHash);

    } finally {
      this.processingTokens.delete(tokenAddress);
    }
  }

  private async getStatus(): Promise<string> {
    const stats = TradeDB.stats();
    const openPositions = this.positionManager.getAll();
    const solBalance = await this.tradeExecutor.getSOLBalance().catch(() => 0);

    return [
      `*TRENCH_AGENT STATUS*`,
      ``,
      `SOL balance: ${solBalance.toFixed(3)}`,
      `Open positions: ${openPositions.length}`,
      `Tracking: ${this.walletTracker.getTrackedCount()} wallets`,
      ``,
      `All-time: ${stats.total} trades | ${stats.winRate}% win rate`,
      `Total P&L: ${stats.totalPnl} SOL`,
      `Dry run: ${PARAMS.DRY_RUN}`,
    ].join('\n');
  }

  private async getPositionsMessage(): Promise<string> {
    const positions = this.positionManager.getAll();
    if (positions.length === 0) return 'No open positions.';

    const lines = positions.map(p => [
      `*$${p.symbol}* — ${p.currentMultiplier.toFixed(2)}x`,
      `  entry: ${p.entrySolAmount} SOL | remaining: ${p.remainingPercent}%`,
      `  peak: ${p.highWaterMark.toFixed(2)}x | CT: ${p.ctMotionDetected ? 'YES' : 'no'}`,
    ].join('\n'));

    return `*OPEN POSITIONS (${positions.length})*\n\n${lines.join('\n\n')}`;
  }

  async stop(): Promise<void> {
    console.log('[Orchestrator] Shutting down...');
    this.walletTracker.stop();
    this.positionManager.stopMonitoring();
    this.signalDetector.destroy();
  }
}
