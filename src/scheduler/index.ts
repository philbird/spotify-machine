import cron, { type ScheduledTask } from 'node-cron';
import { getSettings } from '../db/settings.js';
import { runFullSync } from '../sync/full.js';
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
    try {
      console.log('[scheduler] full sync starting');
      const { stats } = await runFullSync();
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
