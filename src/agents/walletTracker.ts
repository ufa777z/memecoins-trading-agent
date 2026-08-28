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

export class WalletTracker extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  private static DEX_PROGRAMS = new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium CLMM
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  ]);

  constructor() {
    super();
    if (TRACKED_WALLETS.length === 0) {
      console.warn('[WalletTracker] No wallets in TRACKED_WALLETS — add addresses in src/config/params.ts');
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
  }

  private connect(): void {
    const wsUrl = PARAMS.HELIUS_WS_URL;
    if (!wsUrl || wsUrl.includes('api-key=' + '') || !process.env.HELIUS_API_KEY) {
      console.error('[WalletTracker] HELIUS_API_KEY / HELIUS_WS_URL missing');
      return;
    }

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
      if (this.isRunning) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WalletTracker] WebSocket error:', err.message);
    });
  }

  private subscribeToWallets(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    TRACKED_WALLETS.forEach((wallet, index) => {
      const subMsg = {
        jsonrpc: '2.0',
        id: index + 1,
        method: 'transactionSubscribe',
        params: [
          { accountInclude: [wallet], type: 'SWAP' },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            maxSupportedTransactionVersion: 0,
          },
        ],
      };
      this.ws!.send(JSON.stringify(subMsg));
    });

    console.log(`[WalletTracker] Subscribed to ${TRACKED_WALLETS.length} wallets`);
  }

  private handleMessage(msg: any): void {
    if (msg.result && typeof msg.result === 'number') return;
    if (msg.method !== 'transactionNotification') return;

    const tx = msg.params?.result;
    if (!tx) return;

    const event = this.parseTransaction(tx);
    if (event) {
      this.emit('buy', event);
      console.log(
        `[WalletTracker] Buy: ${event.wallet.slice(0, 4)}…${event.wallet.slice(-4)} → ${event.tokenAddress.slice(0, 8)}… (${event.solAmount.toFixed(3)} SOL)`
      );
    }
  }

  private parseTransaction(tx: any): WalletBuyEvent | null {
    try {
      const meta = tx.meta;
      const transaction = tx.transaction;
      const signature = tx.signature || transaction?.signatures?.[0];
      if (!meta || !transaction || meta.err) return null;

      const accountKeys: string[] =
        transaction.message?.accountKeys?.map((k: any) => (typeof k === 'string' ? k : k.pubkey)) ||
        [];

      const signerWallet = accountKeys.find((key) => TRACKED_WALLETS.includes(key));
      if (!signerWallet) return null;

      const involvesDex = accountKeys.some((key) => WalletTracker.DEX_PROGRAMS.has(key));
      if (!involvesDex) return null;

      const preTokenBalances: any[] = meta.preTokenBalances || [];
      const postTokenBalances: any[] = meta.postTokenBalances || [];

      const newTokens = postTokenBalances.filter((post) => {
        const pre = preTokenBalances.find(
          (p) => p.accountIndex === post.accountIndex && p.mint === post.mint
        );
        const preAmt = pre ? parseFloat(pre.uiTokenAmount?.uiAmountString || '0') : 0;
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmountString || '0');
        return postAmt > preAmt && postAmt > 0;
      });
      if (newTokens.length === 0) return null;

      const primaryBuy = newTokens.reduce((best, current) => {
        const bestAmt = parseFloat(best.uiTokenAmount?.uiAmountString || '0');
        const currAmt = parseFloat(current.uiTokenAmount?.uiAmountString || '0');
        return currAmt > bestAmt ? current : best;
      });

      const signerIndex = accountKeys.indexOf(signerWallet);
      const preBalances: number[] = meta.preBalances || [];
      const postBalances: number[] = meta.postBalances || [];
      const solSpent = (preBalances[signerIndex] - postBalances[signerIndex]) / 1e9;
      if (solSpent <= 0 || solSpent > 1000) return null;

      let source: WalletBuyEvent['source'] = 'unknown';
      if (accountKeys.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')) source = 'pumpfun';
      else if (accountKeys.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')) source = 'raydium';
      else if (accountKeys.includes('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')) source = 'jupiter';

      return {
        wallet: signerWallet,
        tokenAddress: primaryBuy.mint,
        solAmount: Math.abs(solSpent),
        txHash: signature,
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

  getTrackedCount(): number {
    return TRACKED_WALLETS.length;
  }
}
