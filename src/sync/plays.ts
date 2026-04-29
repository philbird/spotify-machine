import { db } from '../db/index.js';
import { getRecentlyPlayed } from '../spotify/fetchers.js';
import { upsertTrack } from './full.js';
import { finishRun, startRun } from './runs.js';

export async function runPlaysPoll(): Promise<{ runId: number; stats: PlaysStats }> {
  const runId = startRun('plays');
  const stats: PlaysStats = { fetched: 0, inserted: 0 };

  try {
    const lastPlayedAt = (db().prepare('SELECT MAX(played_at) AS m FROM play_events').get() as { m: string | null } | undefined)?.m ?? null;
    const after = lastPlayedAt ? new Date(lastPlayedAt).getTime() : undefined;

    const items = await getRecentlyPlayed(after);
    stats.fetched = items.length;

    const insertEvent = db().prepare(
      `INSERT INTO play_events (track_id, played_at, context_type, context_uri)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(track_id, played_at) DO NOTHING`
    );
    const upsertCount = db().prepare(
      `INSERT INTO play_counts (track_id, total_plays, first_played_at, last_played_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         total_plays = total_plays + 1,
         first_played_at = MIN(first_played_at, excluded.first_played_at),
         last_played_at = MAX(last_played_at, excluded.last_played_at)`
    );

    const tx = db().transaction(() => {
      for (const item of items) {
        if (!item.track || !item.track.id) continue;
        upsertTrack(item.track);
        const result = insertEvent.run(
          item.track.id,
          item.played_at,
          item.context?.type ?? null,
          item.context?.uri ?? null
        );
        if (result.changes > 0) {
          stats.inserted++;
          upsertCount.run(item.track.id, item.played_at, item.played_at);
        }
      }
    });
    tx();

    finishRun(runId, 'ok', stats);
    return { runId, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(runId, 'error', stats, message);
    throw err;
  }
}

export type PlaysStats = { fetched: number; inserted: number };
