import { db } from './index.js';

export type AppSettings = {
  schedulerEnabled: boolean;
  fullSyncCron: string;
  playsPollCron: string;
};

const DEFAULTS: AppSettings = {
  schedulerEnabled: false,
  fullSyncCron: '0 */6 * * *',
  playsPollCron: '*/30 * * * *',
};

export function getSettings(): AppSettings {
  const rows = db().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    schedulerEnabled: map.get('schedulerEnabled') === 'true' ? true : DEFAULTS.schedulerEnabled,
    fullSyncCron: map.get('fullSyncCron') ?? DEFAULTS.fullSyncCron,
    playsPollCron: map.get('playsPollCron') ?? DEFAULTS.playsPollCron,
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const stmt = db().prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const tx = db().transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stmt.run(key, String(value));
    }
  });
  tx();
  return getSettings();
}
