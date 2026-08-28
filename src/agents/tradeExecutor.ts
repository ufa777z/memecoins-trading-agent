import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PARAMS } from '../config/params.js';

export interface SwapResult {
  success: boolean;
  txHash?: string;
  price: number;
  outputAmount: number;
  error?: string;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class TradeExecutor {
  private connection: Connection;
  private keypair: Keypair | null = null;

  constructor() {
    const rpc = PARAMS.SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || '';
    this.connection = new Connection(rpc || 'https://api.mainnet-beta.solana.com', 'confirmed');

    const pk = process.env.WALLET_PRIVATE_KEY;
    if (pk) {
      try {
        this.keypair = Keypair.fromSecretKey(bs58.decode(pk));
        console.log(`[TradeExecutor] Wallet ${this.keypair.publicKey.toBase58().slice(0, 8)}…`);
      } catch {
        console.error('[TradeExecutor] Invalid WALLET_PRIVATE_KEY');
      }
    } else {
      console.warn('[TradeExecutor] No WALLET_PRIVATE_KEY — dry-run only');
    }
  }

  async getSOLBalance(): Promise<number> {
    if (!this.keypair) return 0;
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / 1e9;
  }

  async buy(tokenAddress: string, solAmount: number): Promise<SwapResult> {
    return this.swap(SOL_MINT, tokenAddress, solAmount, true);
  }

  async sell(tokenAddress: string, percentToSell: number): Promise<SwapResult> {
    // percent-based sell needs token balance; simplified: treat percent as fraction of a 1-unit notional in dry-run
    if (PARAMS.DRY_RUN || !this.keypair) {
      return {
        success: true,
        txHash: 'DRY_RUN_SELL',
        price: 0,
        outputAmount: 0,
      };
    }
    // Production: fetch token balance, sell percentToSell%
    // For safety this scaffold returns dry-style until balance fetch is wired
    console.warn('[TradeExecutor] Live percent-sell needs token account balance wiring');
    return { success: false, price: 0, outputAmount: 0, error: 'sell not fully wired' };
  }

  private async swap(
    inputMint: string,
    outputMint: string,
    amountSol: number,
    isBuy: boolean
  ): Promise<SwapResult> {
    if (PARAMS.DRY_RUN || !this.keypair) {
      console.log(`[TradeExecutor] DRY_RUN ${isBuy ? 'BUY' : 'SELL'} ${amountSol} SOL → ${outputMint.slice(0, 8)}…`);
      return {
        success: true,
        txHash: 'DRY_RUN',
        price: 0,
        outputAmount: amountSol,
      };
    }

    try {
      const amountLamports = Math.floor(amountSol * 1e9);
      const quoteUrl =
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}` +
        `&outputMint=${outputMint}&amount=${amountLamports}` +
        `&slippageBps=${PARAMS.SLIPPAGE_BPS}`;

      const quoteRes = await fetch(quoteUrl);
      if (!quoteRes.ok) throw new Error(`Jupiter quote ${quoteRes.status}`);
      const quote = await quoteRes.json();

      const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: Math.floor(PARAMS.PRIORITY_FEE_SOL * 1e9),
        }),
      });
      if (!swapRes.ok) throw new Error(`Jupiter swap ${swapRes.status}`);
      const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

      const txBuf = Buffer.from(swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.keypair]);

      const sig = await this.connection.sendTransaction(tx, { skipPreflight: false });
      await this.connection.confirmTransaction(sig, 'confirmed');

      const outAmount = Number(quote.outAmount || 0) / 1e6; // rough; decimals vary
      return {
        success: true,
        txHash: sig,
        price: 0,
        outputAmount: isBuy ? outAmount : amountSol,
      };
    } catch (err) {
      return {
        success: false,
        price: 0,
        outputAmount: 0,
        error: (err as Error).message,
      };
    }
  }
}
