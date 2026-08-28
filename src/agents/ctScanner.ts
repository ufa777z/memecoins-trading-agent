/**
 * CT Scanner — Crypto Twitter momentum as amplifier only.
 *
 * Design (aligned with SOUL.md):
 * - Never the primary reason to buy
 * - Measures velocity, organic quality, narrative strength
 * - Uses Grok when GROK_API_KEY is set; falls back to X API search
 */

import { PARAMS, CT_PRIORITY_ACCOUNTS } from '../config/params.js';

export interface CTSignal {
  motionScore: number; // 0–100
  trend: 'none' | 'warming' | 'rising' | 'exploding' | 'fading';
  mentionCount: number;
  uniqueAccounts: number;
  velocityRatio: number; // recent vs baseline
  organicScore: number; // 0–100, penalizes botty spam
  narrativeStrength: number; // 0–100
  priorityMentions: number;
  summary: string;
  raw?: unknown;
}

const EMPTY: CTSignal = {
  motionScore: 0,
  trend: 'none',
  mentionCount: 0,
  uniqueAccounts: 0,
  velocityRatio: 0,
  organicScore: 50,
  narrativeStrength: 0,
  priorityMentions: 0,
  summary: 'CT scanner disabled or no data',
};

export class CTScanner {
  async scan(tokenAddress: string, symbol?: string): Promise<CTSignal> {
    if (!PARAMS.ENABLE_CT_SCANNER) return { ...EMPTY };

    const query = this.buildQuery(tokenAddress, symbol);

    try {
      if (process.env.GROK_API_KEY) {
        return await this.scanWithGrok(query, tokenAddress, symbol);
      }
      if (process.env.X_BEARER_TOKEN) {
        return await this.scanWithXApi(query);
      }
      console.warn('[CTScanner] No GROK_API_KEY or X_BEARER_TOKEN — CT score = 0');
      return { ...EMPTY, summary: 'No CT API key configured' };
    } catch (err) {
      console.error('[CTScanner] Error:', (err as Error).message);
      return { ...EMPTY, summary: `CT error: ${(err as Error).message}` };
    }
  }

  private buildQuery(tokenAddress: string, symbol?: string): string {
    const parts: string[] = [];
    if (symbol) parts.push(`$${symbol}`, symbol);
    // Short CA suffix often used in CT
    if (tokenAddress.length > 8) {
      parts.push(tokenAddress.slice(0, 6), tokenAddress.slice(-4));
    }
    parts.push('solana', 'pump');
    return parts.join(' OR ');
  }

  /**
   * Preferred path: Grok semantic analysis of recent X posts.
   */
  private async scanWithGrok(
    query: string,
    tokenAddress: string,
    symbol?: string
  ): Promise<CTSignal> {
    const prompt = `You are analyzing Crypto Twitter (X) momentum for a Solana memecoin.

Token mint: ${tokenAddress}
Symbol: ${symbol || 'unknown'}
Search context: ${query}

Return ONLY valid JSON (no markdown) with this shape:
{
  "mentionCount": number,
  "uniqueAccounts": number,
  "velocityRatio": number,   // mentions last 15m / avg prior 30m, 1.0 = flat
  "organicScore": number,    // 0-100, high = human discussion, low = bot spam
  "narrativeStrength": number, // 0-100, clear consistent theme
  "priorityMentions": number,  // mentions from known quality accounts
  "trend": "none" | "warming" | "rising" | "exploding" | "fading",
  "summary": "one short sentence"
}

Rules:
- Prefer organic smart discussion over pure hype
- Penalize coordinated shill farms and copy-paste spam
- velocityRatio > 2.5 with organicScore > 50 is interesting
- If almost no real discussion, set trend to none and scores low`;

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-2-latest',
        messages: [
          { role: 'system', content: 'You analyze X/Twitter crypto narratives. Reply with JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      throw new Error(`Grok API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = this.safeParseJson(content);
    return this.toSignal(parsed);
  }

  /**
   * Fallback: raw X recent search + simple heuristics.
   */
  private async scanWithXApi(query: string): Promise<CTSignal> {
    const url = new URL('https://api.twitter.com/2/tweets/search/recent');
    url.searchParams.set('query', `(${query}) -is:retweet lang:en`);
    url.searchParams.set('max_results', '50');
    url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'username,public_metrics');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
    });

    if (!res.ok) {
      throw new Error(`X API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      data?: { id: string; text: string; created_at?: string; author_id?: string; public_metrics?: { like_count?: number; retweet_count?: number } }[];
      includes?: { users?: { id: string; username: string; public_metrics?: { followers_count?: number } }[] };
    };

    const tweets = data.data || [];
    const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));

    const uniqueAuthors = new Set(tweets.map((t) => t.author_id).filter(Boolean));
    const now = Date.now();
    const recent15 = tweets.filter((t) => {
      if (!t.created_at) return false;
      return now - new Date(t.created_at).getTime() < 15 * 60 * 1000;
    });
    const prior = tweets.length - recent15.length;
    const velocityRatio =
      prior > 0 ? recent15.length / Math.max(prior / 2, 1) : recent15.length > 0 ? 3 : 0;

    let priorityMentions = 0;
    for (const t of tweets) {
      const u = t.author_id ? users.get(t.author_id) : undefined;
      if (u && CT_PRIORITY_ACCOUNTS.some((a) => a.toLowerCase() === u.username.toLowerCase())) {
        priorityMentions++;
      }
    }

    // Crude organic heuristic: more unique authors + some engagement = better
    const eng = tweets.reduce(
      (s, t) => s + (t.public_metrics?.like_count || 0) + (t.public_metrics?.retweet_count || 0),
      0
    );
    const organicScore = Math.min(
      100,
      Math.round(
        (uniqueAuthors.size / Math.max(tweets.length, 1)) * 60 +
          Math.min(eng / 10, 30) +
          (priorityMentions > 0 ? 10 : 0)
      )
    );

    const mentionCount = tweets.length;
    let trend: CTSignal['trend'] = 'none';
    if (mentionCount >= PARAMS.CT_MIN_MENTIONS_FOR_SIGNAL) {
      if (velocityRatio >= PARAMS.CT_VELOCITY_SPIKE_RATIO && organicScore >= 45) trend = 'exploding';
      else if (velocityRatio >= 1.8) trend = 'rising';
      else if (mentionCount >= 8) trend = 'warming';
      else trend = 'fading';
    }

    const narrativeStrength = Math.min(100, Math.round(organicScore * 0.6 + Math.min(mentionCount * 2, 40)));

    return this.toSignal({
      mentionCount,
      uniqueAccounts: uniqueAuthors.size,
      velocityRatio,
      organicScore,
      narrativeStrength,
      priorityMentions,
      trend,
      summary: `${mentionCount} mentions, ${uniqueAuthors.size} accounts, vel ${velocityRatio.toFixed(1)}x`,
    });
  }

  private toSignal(raw: Record<string, unknown>): CTSignal {
    const mentionCount = num(raw.mentionCount);
    const uniqueAccounts = num(raw.uniqueAccounts);
    const velocityRatio = num(raw.velocityRatio);
    const organicScore = clamp(num(raw.organicScore, 50));
    const narrativeStrength = clamp(num(raw.narrativeStrength));
    const priorityMentions = num(raw.priorityMentions);
    const trend = normalizeTrend(String(raw.trend || 'none'));

    // Composite motion score — CT is amplifier, not catalyst
    let motionScore = 0;
    motionScore += Math.min(mentionCount * 3, 25);
    motionScore += Math.min(uniqueAccounts * 4, 20);
    motionScore += Math.min(velocityRatio * 12, 25);
    motionScore += organicScore * 0.2;
    motionScore += narrativeStrength * 0.15;
    motionScore += Math.min(priorityMentions * 8, 16);
    motionScore = clamp(Math.round(motionScore));

    // Soft-cap if organic is garbage
    if (organicScore < 30) motionScore = Math.min(motionScore, 35);

    return {
      motionScore,
      trend,
      mentionCount,
      uniqueAccounts,
      velocityRatio,
      organicScore,
      narrativeStrength,
      priorityMentions,
      summary: String(raw.summary || ''),
      raw,
    };
  }

  private safeParseJson(text: string): Record<string, unknown> {
    const cleaned = text.replace(/```json\n?|```/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return {};
        }
      }
      return {};
    }
  }
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeTrend(t: string): CTSignal['trend'] {
  const allowed = ['none', 'warming', 'rising', 'exploding', 'fading'] as const;
  return (allowed.includes(t as CTSignal['trend']) ? t : 'none') as CTSignal['trend'];
}
