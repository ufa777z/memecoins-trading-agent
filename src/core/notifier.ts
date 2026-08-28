import TelegramBot from 'node-telegram-bot-api';
import type { ConvergenceSignal } from '../agents/signalDetector.js';
import type { TokenScore } from '../agents/tokenAnalyzer.js';
import type { Position } from '../agents/positionManager.js';
import type { CTSignal } from '../agents/ctScanner.js';

/**
 * Console always. Telegram if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set.
 */
export class Notifier {
  private bot: TelegramBot | null = null;
  private chatId: string;

  constructor() {
    this.chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

    if (token && this.chatId) {
      try {
        this.bot = new TelegramBot(token, { polling: true });
        console.log('[Notifier] Telegram enabled — signals will also go to your chat');
      } catch (err) {
        console.error('[Notifier] Telegram init failed:', (err as Error).message);
        this.bot = null;
      }
    } else {
      console.log(
        '[Notifier] Console only — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env'
      );
      if (!token) console.log('[Notifier]   missing TELEGRAM_BOT_TOKEN');
      if (!this.chatId) console.log('[Notifier]   missing TELEGRAM_CHAT_ID');
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

  private async sendTelegram(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;
    try {
      await this.bot.sendMessage(this.chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('[Notifier] Telegram send failed:', (err as Error).message);
    }
  }

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

    const consoleBlock = [
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
        : null,
      '',
      `  suggested size: ~${suggestedSol} SOL  (you decide)`,
      '',
      `  GMGN:        https://gmgn.ai/sol/token/${ca}`,
      `  DexScreener: https://dexscreener.com/solana/${ca}`,
      `  Birdeye:     https://birdeye.so/token/${ca}?chain=solana`,
      `  Solscan:     https://solscan.io/token/${ca}`,
      '',
      '  No auto-buy — copy CA and trade yourself',
      '════════════════════════════════════════',
    ]
      .filter((line) => line != null)
      .join('\n');

    console.log('\n' + consoleBlock + '\n');

    await this.sendTelegram(
      [
        `👁 *SIGNAL (manual)* — $${sym}`,
        '',
        'CA: `' + ca + '`',
        '',
        `wallets: ${signal.walletCount}`,
        `score: *${finalScore.toFixed(0)}*/100`,
        `suggested: ~${suggestedSol} SOL`,
        '',
        `[GMGN](https://gmgn.ai/sol/token/${ca})`,
        `[DexScreener](https://dexscreener.com/solana/${ca})`,
        '',
        '_No auto-buy — trade yourself_',
      ].join('\n')
    );
  }

  async notifyEntry(
    signal: ConvergenceSignal,
    score: TokenScore,
    sol: number,
    _price: number,
    txHash?: string
  ): Promise<void> {
    const text = [
      `ENTERED $${score.symbol}`,
      `CA: ${signal.tokenAddress}`,
      `wallets: ${signal.walletCount} | size: ${sol} SOL`,
      txHash ? `tx: ${txHash}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    console.log(text);
    await this.sendTelegram(text);
  }

  async notifyExit(
    position: Position,
    percent: number,
    _solOut: number,
    message: string
  ): Promise<void> {
    const text = `EXIT $${position.symbol} ${percent}% — ${message}`;
    console.log(text);
    await this.sendTelegram(text);
  }

  async notifyEmergency(position: Position, message: string): Promise<void> {
    const text = `EMERGENCY $${position.symbol}: ${message}`;
    console.log(text);
    await this.sendTelegram(text);
  }

  async notifySkip(token: string, symbol: string, score: TokenScore, reason: string): Promise<void> {
    console.log(`[SKIP] $${symbol || token.slice(0, 8)} — ${reason} (score ${score.composite})`);
  }

  async notifyCTMotion(position: Position, ct: CTSignal): Promise<void> {
    const text = `CT $${position.symbol}: ${ct.trend} score ${ct.motionScore} — ${ct.summary}`;
    console.log(text);
    await this.sendTelegram(text);
  }
}
