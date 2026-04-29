import { closeDb } from './db/index.js';
import { runFullSync } from './sync/full.js';
import { runPlaysPoll } from './sync/plays.js';

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'full';
  if (arg !== 'full' && arg !== 'plays' && arg !== 'all') {
    console.error('Usage: npm run sync -- [full|plays|all]   (default: full)');
    process.exit(2);
  }

  if (arg === 'full' || arg === 'all') {
    console.log('Running full sync...');
    const { stats } = await runFullSync();
    console.log('Full sync done:', stats);
  }
  if (arg === 'plays' || arg === 'all') {
    console.log('Polling recently played...');
    const { stats } = await runPlaysPoll();
    console.log('Plays poll done:', stats);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
