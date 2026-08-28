import TelegramBot from 'node-telegram-bot-api';
import type { ConvergenceSignal } from '../agents/signalDetector.js';
import type { TokenScore } from '../agents/tokenAnalyzer.js';
import type { Position } from '../agents/positionManager.js';
import type { CTSignal } from '../agents/ctScanner.js';

/**
 * Minimal Telegram alerts — style from PERSONALITY.md
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
      await this.bot!.sendMessage(this.chatId, await handlers.onStatus(), { parse_mode: 'Markdown' });
    });
    this.bot.onText(/\/report/, async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot!.sendMessage(this.chatId, await handlers.onReport(), { parse_mode: 'Markdown' });
    });
    this.bot.onText(/\/positions/, async (msg) => {
      if (String(msg.chat.id) !== this.chatId) return;
      await this.bot!.sendMessage(this.chatId, await handlers.onPositions(), { parse_mode: 'Markdown' });
    });
  }

  private async send(text: string): Promise<void> {
    console.log(text);
    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('[Notifier]', (err as Error).message);
      }
    }
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
    solOut: number,
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
    await this.send(`⚫ SKIPPED: $${symbol || token.slice(0, 8)}\nreason: ${reason} | score ${score.composite}/100`);
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
