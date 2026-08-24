import cron, { type ScheduledTask } from 'node-cron';
import { getSettings } from '../db/settings.js';
import { startFullSyncJob } from '../sync/fullSyncJob.js';
import { runPlaysPoll } from '../sync/plays.js';

let fullTask: ScheduledTask | null = null;
let playsTask: ScheduledTask | null = null;

export function applySchedule(): void {
  fullTask?.stop();
  playsTask?.stop();
  fullTask = null;
  playsTask = null;

  const settings = getSettings();
  if (!settings.schedulerEnabled) {
    console.log('[scheduler] disabled');
    return;
  }

  if (!cron.validate(settings.fullSyncCron)) {
    console.error(`[scheduler] invalid full sync cron: ${settings.fullSyncCron}`);
    return;
  }
  if (!cron.validate(settings.playsPollCron)) {
    console.error(`[scheduler] invalid plays poll cron: ${settings.playsPollCron}`);
    return;
  }

  fullTask = cron.schedule(settings.fullSyncCron, async () => {
    // Shares the exclusivity guard with the API and CLI: if a full sync is
    // already running this tick is skipped rather than doubling up.
    const result = startFullSyncJob();
    if (!result.started) {
      console.log(`[scheduler] full sync skipped — run ${result.runId} is already in progress`);
      return;
    }
    console.log(`[scheduler] full sync starting (run ${result.runId})`);
    try {
      const stats = await result.completion;
      console.log('[scheduler] full sync done', stats);
    } catch (err) {
      console.error('[scheduler] full sync failed', err);
    }
  });

  playsTask = cron.schedule(settings.playsPollCron, async () => {
    try {
      const { stats } = await runPlaysPoll();
      if (stats.inserted > 0) console.log('[scheduler] plays poll inserted', stats.inserted);
    } catch (err) {
      console.error('[scheduler] plays poll failed', err);
    }
  });

  console.log(`[scheduler] enabled — full=${settings.fullSyncCron}, plays=${settings.playsPollCron}`);
}

export function stopSchedule(): void {
  fullTask?.stop();
  playsTask?.stop();
  fullTask = null;
  playsTask = null;
}
