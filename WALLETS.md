# Tracked wallets (v1.2)

**30 addresses** seeded from public May–Aug 2026 leaderboards:

- [KOL Explorer / solana-trading.com](https://solana-trading.com/blog/memecoin-trader-wallets-top10-2026)
- [Subglow / kolscan](https://subglow.io/solana-smart-money-tracker)
- Dune community profitable-trader samples

## Important

These are **starting candidates**, not a permanent edge.

1. Run `npx tsx scripts/validate-wallets.ts`
2. Open GMGN + Cielo for each address
3. Drop wallets that went cold, bot-only, or negative 30d PnL
4. Prefer: many trades, diversified tokens, ≥~35–40% win rate, positive realized PnL

Edge half-life on meme copy lists is short (weeks). Refresh the list regularly.

Configured in `src/config/params.ts` → `TRACKED_WALLETS`.
