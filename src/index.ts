import 'dotenv/config';
import { Orchestrator } from './core/orchestrator.js';
import { PARAMS } from './config/params.js';

const agent = new Orchestrator();

async function main() {
  console.log('TRENCH_AGENT — console signal mode');
  console.log(`MANUAL_MODE=${PARAMS.MANUAL_MODE}  (no auto-buy)`);
  console.log('Watching smart wallets… signals print below when ≥3 converge.\n');
  await agent.start();
}

process.on('SIGINT', async () => {
  await agent.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await agent.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
