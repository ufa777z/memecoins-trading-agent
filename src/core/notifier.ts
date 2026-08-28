import TelegramBot from 'node-telegram-bot-api';
import type { ConvergenceSignal } from '../agents/signalDetector.js';
import type { TokenScore } from '../agents/tokenAnalyzer.js';
import type { Position } from '../agents/positionManager.js';
import type { CTSignal } from '../agents/ctScanner.js';

/**
 * Telegram / console alerts — manual mode focuses on CA + links.
 */
export class Notifier {
  private bot: TelegramBot | null = null;
  private chatId: string;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    if (token && this.chatId) {
      this.bot = new TelegramBot(token, { polling: true });
      console.log('[Notifier] Telegram ready');
    } else {
      console.warn('[Notifier] TELEGRAM_BOT_TOKEN / CHAT_ID missing — console only');
    }
  }

  setupCommands(handlers: {
    onStatus: () => Promise<string>;
    onReport: () => Promise<string>;
    onPositions: () => Promise<string>;
  }): void {
    if (!this.bot) return;
    this.bot.onText(/\/status/, async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot!.sendMessage(this.chatId, await handlers.onStatus(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
    this.bot.onText(/\/report/, async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot!.sendMessage(this.chatId, await handlers.onReport(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
    this.bot.onText(/\/positions/, async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot!.sendMessage(this.chatId, await handlers.onPositions(), {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    });
  }

  private async send(text: string): Promise<void> {
    console.log(text);
    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(this.chatId, text, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      } catch (err) {
        console.error('[Notifier]', (err as Error).message);
      }
    }
  }

  /** Primary alert for manual trading — coin only, no auto-buy */
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

    await this.send(
      [
        `👁 *SIGNAL (manual)* — $${sym}`,
        '',
        `CA: \`${ca}\``,
        '',
        `wallets: ${signal.walletCount} (${shortWallets})`,
        `window: ~${Math.max(1, Math.round((signal.lastSeen - signal.firstSeen) / 1000))}s`,
        `smart SOL seen: ${signal.totalSol.toFixed(2)}`,
        '',
        `score: *${finalScore.toFixed(0)}*/100  (base ${score.composite} + CT ${ctScore})`,
        `vol ${score.volume} | hold ${score.holders} | dev ${score.dev} | dist ${score.distribution}`,
        score.volumeUsd != null ? `24h vol ~$${Math.round(score.volumeUsd).toLocaleString()}` : '',
        '',
        `suggested size (if you trade): ~${suggestedSol} SOL`,
        '',
        `[GMGN](https://gmgn.ai/sol/token/${ca})`,
        `[DexScreener](https://dexscreener.com/solana/${ca})`,
        `[Birdeye](https://birdeye.so/token/${ca}?chain=solana)`,
        `[Solscan](https://solscan.io/token/${ca})`,
        '',
        `_No auto-buy — copy CA and trade yourself_`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async notifyEntry(
    signal: ConvergenceSignal,
    score: TokenScore,
    sol: number,
    price: number,
    txHash?: string
  ): Promise<void> {
    await this.send(
      [
        `🟢 SIGNAL: $${score.symbol}`,
        `CA: \`${signal.tokenAddress}\``,
        '',
        `wallets in: ${signal.walletCount}`,
        `buy size: ${sol} SOL`,
        '',
        `scores: vol ${score.volume} | hold ${score.holders} | dev ${score.dev} | dist ${score.distribution}`,
        `composite: ${score.composite}/100 → ENTERING`,
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
      [
        `🔴 EXIT: $${position.symbol} | partial (${percent}%)`,
        '',
        `reason: ${message}`,
        `remaining: ${Math.max(0, position.remainingPercent - percent)}%`,
      ].join('\n')
    );
  }

  async notifyEmergency(position: Position, message: string): Promise<void> {
    await this.send(`🔴 EMERGENCY: $${position.symbol}\n${message}`);
  }

  async notifySkip(token: string, symbol: string, score: TokenScore, reason: string): Promise<void> {
    await this.send(
      `⚫ SKIPPED: $${symbol || token.slice(0, 8)}\nreason: ${reason} | score ${score.composite}/100`
    );
  }

  async notifyCTMotion(position: Position, ct: CTSignal): Promise<void> {
    await this.send(
      [
        `🟡 CT MOTION: $${position.symbol}`,
        `trend: ${ct.trend} | score ${ct.motionScore}/100`,
        `mentions: ${ct.mentionCount} | organic: ${ct.organicScore}`,
        ct.summary,
      ].join('\n')
    );
  }
}
