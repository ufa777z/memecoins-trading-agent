import 'dotenv/config';
import { Orchestrator } from './core/orchestrator.js';

const agent = new Orchestrator();

async function main() {
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
