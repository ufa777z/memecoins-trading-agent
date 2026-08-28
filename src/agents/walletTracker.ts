import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { PARAMS, TRACKED_WALLETS } from '../config/params.js';

export interface WalletBuyEvent {
  wallet: string;
  tokenAddress: string;
  tokenSymbol?: string;
  solAmount: number;
  txHash: string;
  timestamp: number;
  source: 'pumpfun' | 'raydium' | 'jupiter' | 'unknown';
}

function resolveWsUrl(): string {
  const fromEnv = (process.env.HELIUS_WS_URL || '').trim();
  if (fromEnv) return fromEnv;

  const key = (process.env.HELIUS_API_KEY || '').trim();
  if (key) return `wss://mainnet.helius-rpc.com/?api-key=${key}`;

  return (PARAMS.HELIUS_WS_URL || '').trim();
}

function isWsConfigured(wsUrl: string): boolean {
  if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) return false;
  if (/api-key=\s*$/i.test(wsUrl) || /api-key=&/i.test(wsUrl)) return false;
  const key = (process.env.HELIUS_API_KEY || '').trim();
  if (key) return true;
  const m = wsUrl.match(/api-key=([^&\s]+)/i);
  return !!(m && m[1] && m[1].length > 8);
}

export class WalletTracker extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private txNotifications = 0;
  private buyEvents = 0;

  private static DEX_PROGRAMS = new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium CLMM
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // Pump AMM
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  ]);

  constructor() {
    super();
    if (TRACKED_WALLETS.length === 0) {
      console.warn(
        '[WalletTracker] No wallets in TRACKED_WALLETS — add addresses in src/config/params.ts'
      );
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
    console.log(`[WalletTracker] Starting. Tracking ${TRACKED_WALLETS.length} wallets.`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private connect(): void {
    const wsUrl = resolveWsUrl();
    if (!isWsConfigured(wsUrl)) {
      console.error(
        '[WalletTracker] HELIUS_API_KEY / HELIUS_WS_URL missing or invalid. Set both in .env'
      );
      return;
    }

    console.log('[WalletTracker] Connecting to Helius WebSocket...');

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[WalletTracker] WebSocket creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[WalletTracker] Connected to Helius WebSocket');
      this.subscribeToWallets();
      this.startPing();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        /* ignore */
      }
    });

    this.ws.on('close', () => {
      console.log('[WalletTracker] WebSocket closed, reconnecting...');
      if (this.pingInterval) clearInterval(this.pingInterval);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.isRunning) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WalletTracker] WebSocket error:', err.message);
    });
  }

  /**
   * One subscription for all wallets (Helius allows many accountInclude).
   * No invalid `type: SWAP` filter. tokenAccounts catches ATA balance changes.
   */
  private subscribeToWallets(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          vote: false,
          failed: false,
          accountInclude: [...TRACKED_WALLETS],
          tokenAccounts: 'balanceChanged',
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this.ws.send(JSON.stringify(subMsg));
    console.log(
      `[WalletTracker] Subscribed to ${TRACKED_WALLETS.length} wallets (single stream + ATA)`
    );
    console.log(
      '[WalletTracker] Waiting for txs… (idle is normal if those wallets are not trading)'
    );
  }

  private handleMessage(msg: any): void {
    // Subscription ack
    if (msg.result != null && msg.method == null) {
      console.log(`[WalletTracker] Subscription confirmed (id=${msg.result})`);
      return;
    }

    if (msg.error) {
      console.error('[WalletTracker] Helius error:', JSON.stringify(msg.error));
      return;
    }

    if (msg.method !== 'transactionNotification') return;

    this.txNotifications += 1;
    const tx = msg.params?.result ?? msg.params;
    if (!tx) return;

    const event = this.parseTransaction(tx);
    if (event) {
      this.buyEvents += 1;
      this.emit('buy', event);
      console.log(
        `[WalletTracker] Buy: ${event.wallet.slice(0, 4)}…${event.wallet.slice(-4)} → ${event.tokenAddress.slice(0, 8)}… (${event.solAmount.toFixed(3)} SOL) [${event.source}]`
      );
    }
  }

  private parseTransaction(tx: any): WalletBuyEvent | null {
    try {
      // Helius may nest under transaction / meta at top level of result
      const meta = tx.meta ?? tx.transaction?.meta;
      const transaction = tx.transaction?.transaction ?? tx.transaction;
      const signature =
        tx.signature ||
        transaction?.signatures?.[0] ||
        tx.transaction?.signatures?.[0];

      if (!meta || meta.err) return null;

      const message = transaction?.message ?? tx.transaction?.message;
      if (!message) return null;

      const accountKeys: string[] =
        message.accountKeys?.map((k: any) =>
          typeof k === 'string' ? k : k.pubkey || k
        ) || [];

      const trackedSet = new Set(TRACKED_WALLETS);
      const signerWallet = accountKeys.find((key) => trackedSet.has(key));

      // Also match via token balance owner (ATA path)
      const postTokenBalances: any[] = meta.postTokenBalances || [];
      const preTokenBalances: any[] = meta.preTokenBalances || [];

      let wallet = signerWallet;
      if (!wallet) {
        for (const post of postTokenBalances) {
          if (post.owner && trackedSet.has(post.owner)) {
            wallet = post.owner;
            break;
          }
        }
      }
      if (!wallet) return null;

      // Prefer DEX involvement, but don't hard-require if token balance rose
      const involvesDex = accountKeys.some((key) => WalletTracker.DEX_PROGRAMS.has(key));

      const ownerIncreases = postTokenBalances.filter((post) => {
        if (post.owner !== wallet) return false;
        const mint = post.mint;
        if (!mint || mint === 'So11111111111111111111111111111111111111112') return false;
        const pre = preTokenBalances.find(
          (p) => p.accountIndex === post.accountIndex && p.mint === mint
        );
        const preAmt = pre ? parseFloat(pre.uiTokenAmount?.uiAmountString || '0') : 0;
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmountString || '0');
        return postAmt > preAmt && postAmt > 0;
      });

      if (ownerIncreases.length === 0) return null;
      if (!involvesDex && ownerIncreases.length === 0) return null;

      const primaryBuy = ownerIncreases.reduce((best, current) => {
        const bestAmt = parseFloat(best.uiTokenAmount?.uiAmountString || '0');
        const currAmt = parseFloat(current.uiTokenAmount?.uiAmountString || '0');
        return currAmt > bestAmt ? current : best;
      });

      const signerIndex = accountKeys.indexOf(wallet);
      const preBalances: number[] = meta.preBalances || [];
      const postBalances: number[] = meta.postBalances || [];
      let solSpent = 0;
      if (signerIndex >= 0 && preBalances[signerIndex] != null) {
        solSpent = (preBalances[signerIndex] - postBalances[signerIndex]) / 1e9;
      }
      // Fee-only or receive path — still count as buy if token increased
      if (solSpent < 0) solSpent = Math.abs(solSpent);
      if (solSpent > 1000) return null;

      let source: WalletBuyEvent['source'] = 'unknown';
      if (accountKeys.some((k) => k.includes && false)) {
        /* keep ts happy */
      }
      if (accountKeys.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))
        source = 'pumpfun';
      else if (accountKeys.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'))
        source = 'pumpfun';
      else if (accountKeys.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'))
        source = 'raydium';
      else if (
        accountKeys.includes('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') ||
        accountKeys.includes('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB')
      )
        source = 'jupiter';

      return {
        wallet,
        tokenAddress: primaryBuy.mint,
        solAmount: solSpent > 0 ? solSpent : 0.001,
        txHash: signature || '',
        timestamp: Date.now(),
        source,
      };
    } catch {
      return null;
    }
  }

  private scheduleReconnect(delay = 5000): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.isRunning) this.connect();
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, 30_000);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      console.log(
        `[WalletTracker] heartbeat — txs seen: ${this.txNotifications}, buys parsed: ${this.buyEvents}`
      );
    }, 60_000);
  }

  getTrackedCount(): number {
    return TRACKED_WALLETS.length;
  }
}
