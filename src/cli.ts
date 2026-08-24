import { closeDb } from './db/index.js';
import { recoverInterruptedRuns, startFullSyncJob } from './sync/fullSyncJob.js';
import { runPlaysPoll } from './sync/plays.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  const arg = positional[0] ?? 'full';
  if (arg !== 'full' && arg !== 'plays' && arg !== 'all') {
    console.error('Usage: npm run sync -- [full|plays|all] [--force]   (default: full)');
    process.exit(2);
  }

  // Same startup recovery as the server: stale 'running' rows from a dead
  // process are marked interrupted before this process starts a job.
  recoverInterruptedRuns();

  if (arg === 'full' || arg === 'all') {
    console.log(`Running full sync${force ? ' (force)' : ''}...`);
    const result = startFullSyncJob({ force });
    if (!result.started) {
      console.error(`A full sync is already running (run ${result.runId}); not starting another.`);
      process.exitCode = 1;
      return;
    }
    const stats = await result.completion;
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
