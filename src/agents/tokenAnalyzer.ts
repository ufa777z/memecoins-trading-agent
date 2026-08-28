import { PARAMS } from '../config/params.js';

export interface TokenScore {
  symbol: string;
  name?: string;
  composite: number;
  volume: number;
  holders: number;
  dev: number;
  distribution: number;
  pass: boolean;
  failReasons: string[];
  volumeUsd?: number;
  holderCount?: number;
  top10Pct?: number;
}

/**
 * Scores a token 0–100 using DexScreener (+ optional Helius later).
 * Hard fails: extreme concentration, known-bad patterns when detectable.
 */
export class TokenAnalyzer {
  async score(tokenAddress: string): Promise<TokenScore | null> {
    try {
      const ds = await this.fetchDexScreener(tokenAddress);
      if (!ds) return null;

      const failReasons: string[] = [];
      const volumeUsd = ds.volume?.h24 ?? 0;
      const liquidityUsd = ds.liquidity?.usd ?? 0;
      const symbol = ds.baseToken?.symbol || 'UNKNOWN';

      // Volume score
      let volume = 40;
      if (volumeUsd < 30_000) volume = 25;
      else if (volumeUsd < 50_000) volume = 45;
      else if (volumeUsd <= 500_000) volume = 80;
      else if (volumeUsd <= 2_000_000) volume = 65;
      else volume = 40; // late

      // Holders — DexScreener doesn't always give holder count; approximate via txns if missing
      const holderCount = ds.holders ?? ds.info?.holders ?? 0;
      let holders = 50;
      if (holderCount > 0) {
        if (holderCount < PARAMS.MIN_HOLDERS) {
          holders = 25;
          failReasons.push(`holders ${holderCount} < ${PARAMS.MIN_HOLDERS}`);
        } else if (holderCount <= 1000) holders = 85;
        else if (holderCount <= 5000) holders = 70;
        else if (holderCount > PARAMS.MAX_HOLDERS_LATE) {
          holders = 35;
          failReasons.push('holder count very high — late');
        } else holders = 50;
      }

      // Distribution — use top10 if available from pair metadata; else neutral
      const top10Pct = ds.top10HolderPct ?? null;
      let distribution = 60;
      if (top10Pct != null) {
        if (top10Pct > 70) {
          distribution = 0;
          failReasons.push(`top10 holders ${top10Pct.toFixed(0)}% > 70%`);
        } else if (top10Pct > PARAMS.MAX_TOP10_HOLDER_PCT) {
          distribution = 30;
          failReasons.push(`top10 holders ${top10Pct.toFixed(0)}% high`);
        } else if (top10Pct < 35) distribution = 90;
        else distribution = 70;
      }

      // Dev score — without full Helius rug DB we use liquidity + pair age heuristics
      let dev = 55;
      const pairCreated = ds.pairCreatedAt ? Number(ds.pairCreatedAt) : 0;
      const ageMin = pairCreated ? (Date.now() - pairCreated) / 60_000 : 999;
      if (liquidityUsd < 5_000) {
        dev = 30;
        failReasons.push('very low liquidity');
      } else if (liquidityUsd > 20_000 && ageMin > 10) {
        dev = 70;
      }

      const composite = Math.round(
        volume * PARAMS.WEIGHT_VOLUME +
          holders * PARAMS.WEIGHT_HOLDERS +
          dev * PARAMS.WEIGHT_DEV +
          distribution * PARAMS.WEIGHT_DISTRIBUTION
      );

      const hardFail = distribution === 0 || failReasons.some((r) => r.includes('> 70%'));
      const pass = !hardFail && composite >= 40;

      return {
        symbol,
        name: ds.baseToken?.name,
        composite,
        volume,
        holders,
        dev,
        distribution,
        pass,
        failReasons,
        volumeUsd,
        holderCount: holderCount || undefined,
        top10Pct: top10Pct ?? undefined,
      };
    } catch (err) {
      console.error('[TokenAnalyzer]', (err as Error).message);
      return null;
    }
  }

  private async fetchDexScreener(mint: string): Promise<any | null> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs?: any[] };
    const pairs = data.pairs || [];
    if (pairs.length === 0) return null;
    // Prefer Solana pairs by liquidity
    const sol = pairs.filter((p) => p.chainId === 'solana');
    const list = sol.length ? sol : pairs;
    list.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return list[0];
  }
}
