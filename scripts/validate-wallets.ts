/**
 * Helper: print tracked wallets + links to re-validate on GMGN / Solscan / Cielo.
 *
 * Usage: npx tsx scripts/validate-wallets.ts
 *
 * Leaderboards rot. Before going live, open each link and check:
 * - 7d/30d realized PnL still positive
 * - Trade count not collapsed
 * - Not purely bot/sniper with sub-second holds only
 * - Win rate roughly consistent with when you added them
 */

import { TRACKED_WALLETS } from '../src/config/params.js';

console.log(`\nTRACKED_WALLETS: ${TRACKED_WALLETS.length}\n`);

TRACKED_WALLETS.forEach((w, i) => {
  console.log(`${String(i + 1).padStart(2, '0')}. ${w}`);
  console.log(`    GMGN:    https://gmgn.ai/sol/address/${w}`);
  console.log(`    Solscan: https://solscan.io/account/${w}`);
  console.log(`    Cielo:   https://app.cielo.finance/profile/${w}`);
  console.log('');
});

console.log('Re-run this after pruning underperformers from params.ts');
