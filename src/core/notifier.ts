import type { ConvergenceSignal } from '../agents/signalDetector.js';
import type { TokenScore } from '../agents/tokenAnalyzer.js';
import type { Position } from '../agents/positionManager.js';
import type { CTSignal } from '../agents/ctScanner.js';

/**
 * Console-first alerts. Telegram is optional — only if both env vars are set.
 */
export class Notifier {
  private bot: any = null;
  private chatId: string;

  constructor() {
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (token && this.chatId) {
      try {
        // Dynamic import-style require avoided; load only if configured
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const TelegramBot = require('node-telegram-bot-api');
        this.bot = new TelegramBot(token, { polling: true });
        console.log('[Notifier] Telegram optional channel enabled');
      } catch (err) {
        console.warn('[Notifier] Telegram package/init failed — console only');
        this.bot = null;
      }
    } else {
      console.log('[Notifier] Console only (no TELEGRAM_* env) — signals print here');
    }
  }

  setupCommands(handlers: {
    onStatus: () => Promise<string>;
    onReport: () => Promise<string>;
    onPositions: () => Promise<string>;
  }): void {
    if (!this.bot) return;
    this.bot.onText(/\/status/, async (msg: any) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot.sendMessage(this.chatId, await handlers.onStatus(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
    this.bot.onText(/\/report/, async (msg: any) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot.sendMessage(this.chatId, await handlers.onReport(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
    this.bot.onText(/\/positions/, async (msg: any) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot.sendMessage(this.chatId, await handlers.onPositions(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
  }

  private async send(text: string): Promise<void> {
    // Always print clean console block
    console.log('\n' + text + '\n');

    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(this.chatId, text, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch (err) {
        console.error('[Notifier] Telegram send failed:', (err as Error).message);
      }
    }
  }

  /** Primary alert — coin only, no auto-buy */
  async notifySignalOnly(
    signal: ConvergenceSignal,
    score: TokenScore,
    finalScore: number,
    suggestedSol: number,
    ctScore: number
  ): Promise<void> {
    const ca = signal.tokenAddress;
    const sym = score.symbol || 'UNKNOWN';
    const shortWallets = signal.wallets
      .map((w) => `${w.slice(0, 4)}…${w.slice(-4)}`)
      .join(', ');
    const windowSec = Math.max(1, Math.round((signal.lastSeen - signal.firstSeen) / 1000));

    // Plain-text friendly for terminal (no Markdown noise)
    const block = [
      '════════════════════════════════════════',
      `  SIGNAL (manual)  $${sym}`,
      '════════════════════════════════════════',
      `  CA: ${ca}`,
      '',
      `  wallets: ${signal.walletCount}  (${shortWallets})`,
      `  window:  ~${windowSec}s`,
      `  smart SOL in: ${signal.totalSol.toFixed(2)}`,
      '',
      `  score: ${finalScore.toFixed(0)}/100  (base ${score.composite} + CT ${ctScore})`,
      `  vol ${score.volume} | hold ${score.holders} | dev ${score.dev} | dist ${score.distribution}`,
      score.volumeUsd != null
        ? `  24h vol ~$${Math.round(score.volumeUsd).toLocaleString()}`
        : '',
      '',
      `  suggested size: ~${suggestedSol} SOL  (you decide)`,
      '',
      `  GMGN:       https://gmgn.ai/sol/token/${ca}`,
      `  DexScreener: https://dexscreener.com/solana/${ca}`,
      `  Birdeye:    https://birdeye.so/token/${ca}?chain=solana`,
      `  Solscan:    https://solscan.io/token/${ca}`,
      '',
      '  No auto-buy — copy CA and trade yourself',
      '════════════════════════════════════════',
    ]
      .filter((line) => line !== '')
      .join('\n');

    console.log('\n' + block + '\n');

    // Optional Telegram (Markdown version)
    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(
          this.chatId,
          [
            `👁 *SIGNAL (manual)* — $${sym}`,
            '',
            `CA: \`${ca}\``,
            '',
            `wallets: ${signal.walletCount}`,
            `score: *${finalScore.toFixed(0)}*/100`,
            `suggested: ~${suggestedSol} SOL`,
            '',
            `[GMGN](https://gmgn.ai/sol/token/${ca})`,
            `[DexScreener](https://dexscreener.com/solana/${ca})`,
          ].join('\n'),
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      } catch {
        /* ignore */
      }
    }
  }

  async notifyEntry(
    signal: ConvergenceSignal,
    score: TokenScore,
    sol: number,
    _price: number,
    txHash?: string
  ): Promise<void> {
    await this.send(
      [
        `ENTERED $${score.symbol}`,
        `CA: ${signal.tokenAddress}`,
        `wallets: ${signal.walletCount} | size: ${sol} SOL`,
        txHash ? `tx: ${txHash}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async notifyExit(
    position: Position,
    percent: number,
    _solOut: number,
    message: string
  ): Promise<void> {
    await this.send(
      `EXIT $${position.symbol} ${percent}% — ${message}`
    );
  }

  async notifyEmergency(position: Position, message: string): Promise<void> {
    await this.send(`EMERGENCY $${position.symbol}: ${message}`);
  }

  async notifySkip(token: string, symbol: string, score: TokenScore, reason: string): Promise<void> {
    console.log(`[SKIP] $${symbol || token.slice(0, 8)} — ${reason} (score ${score.composite})`);
  }

  async notifyCTMotion(position: Position, ct: CTSignal): Promise<void> {
    await this.send(
      `CT $${position.symbol}: ${ct.trend} score ${ct.motionScore} — ${ct.summary}`
    );
  }
}
