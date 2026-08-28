import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
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
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

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

  /** Approximate token price in SOL via DexScreener */
  async getTokenPriceSol(mint: string): Promise<number> {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (!res.ok) return 0;
      const data = (await res.json()) as { pairs?: any[] };
      const pairs = (data.pairs || []).filter((p) => p.chainId === 'solana');
      if (!pairs.length) return 0;
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const p = pairs[0];
      const priceUsd = Number(p.priceUsd || 0);
      const solUsd = Number(p.priceNative ? priceUsd / Number(p.priceNative) : 0);
      // priceNative is token price in SOL on many pairs
      if (p.priceNative) return Number(p.priceNative);
      if (solUsd > 0 && priceUsd > 0) return priceUsd / solUsd;
      return Number(p.priceNative || 0);
    } catch {
      return 0;
    }
  }

  async buy(tokenAddress: string, solAmount: number): Promise<SwapResult> {
    return this.swap(SOL_MINT, tokenAddress, Math.floor(solAmount * 1e9), true);
  }

  /**
   * Sell percent (0–100) of token balance via Jupiter.
   */
  async sell(tokenAddress: string, percentToSell: number): Promise<SwapResult> {
    if (PARAMS.DRY_RUN || !this.keypair) {
      console.log(`[TradeExecutor] DRY_RUN SELL ${percentToSell}% of ${tokenAddress.slice(0, 8)}…`);
      return { success: true, txHash: 'DRY_RUN_SELL', price: 0, outputAmount: 0 };
    }

    try {
      const { amount, decimals } = await this.getTokenBalanceRaw(tokenAddress);
      if (amount <= 0n) {
        return { success: false, price: 0, outputAmount: 0, error: 'zero token balance' };
      }

      const sellAmount =
        (amount * BigInt(Math.min(100, Math.max(1, Math.floor(percentToSell))))) / 100n;
      if (sellAmount <= 0n) {
        return { success: false, price: 0, outputAmount: 0, error: 'sell amount too small' };
      }

      const result = await this.swap(tokenAddress, SOL_MINT, Number(sellAmount), false);
      if (result.success) {
        // outputAmount is lamports-ish from quote; normalize to SOL if needed
        result.outputAmount = result.outputAmount > 1e6 ? result.outputAmount / 1e9 : result.outputAmount;
      }
      return result;
    } catch (err) {
      return {
        success: false,
        price: 0,
        outputAmount: 0,
        error: (err as Error).message,
      };
    }
  }

  private async getTokenBalanceRaw(
    mint: string
  ): Promise<{ amount: bigint; decimals: number }> {
    if (!this.keypair) return { amount: 0n, decimals: 0 };

    const mintPk = new PublicKey(mint);
    const owner = this.keypair.publicKey;

    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const resp = await this.connection.getParsedTokenAccountsByOwner(owner, {
        mint: mintPk,
        programId,
      });
      for (const { account } of resp.value) {
        const info = (account.data as any).parsed?.info?.tokenAmount;
        if (!info) continue;
        const amount = BigInt(info.amount || '0');
        if (amount > 0n) {
          return { amount, decimals: Number(info.decimals || 0) };
        }
      }
    }
    return { amount: 0n, decimals: 0 };
  }

  private async swap(
    inputMint: string,
    outputMint: string,
    amountRaw: number,
    isBuy: boolean
  ): Promise<SwapResult> {
    if (PARAMS.DRY_RUN || !this.keypair) {
      console.log(
        `[TradeExecutor] DRY_RUN ${isBuy ? 'BUY' : 'SELL'} raw=${amountRaw} ${inputMint.slice(0, 6)}→${outputMint.slice(0, 6)}`
      );
      return {
        success: true,
        txHash: 'DRY_RUN',
        price: 0,
        outputAmount: isBuy ? amountRaw / 1e9 : amountRaw / 1e9,
      };
    }

    try {
      const quoteUrl =
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}` +
        `&outputMint=${outputMint}&amount=${amountRaw}` +
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

      const outAmount = Number(quote.outAmount || 0);
      const inAmount = Number(quote.inAmount || amountRaw);
      const price = isBuy && outAmount > 0 ? inAmount / outAmount : 0;

      return {
        success: true,
        txHash: sig,
        price,
        outputAmount: outAmount,
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
