import { db } from '../db/index.js';
import { SpotifyError } from '../spotify/client.js';
import { getAllPlaylists, getCurrentUser, getLikedTracks, getPlaylistTracks } from '../spotify/fetchers.js';
import type { SpotifyPlaylist, SpotifyPlaylistTrackItem, SpotifyTrack } from '../spotify/types.js';
import {
  emptyProgress,
  finishRun,
  sanitizeErrorMessage,
  updateRunProgress,
  type SyncProgress,
} from './runs.js';

const LIKED_PLAYLIST_ID = '__liked__';

type TrackRow = { track_id: string; position: number; added_at: string | null };

type SyncContext = {
  runId: number;
  stats: SyncStats;
  progress: SyncProgress;
};

// Performs the full sync against an already-created sync_runs row. Callers
// obtain the row through fullSyncJob.ts, which enforces one-at-a-time
// execution — do not call this with a runId that was not claimed there.
//
// The run row is finalized on every path: 'ok' on success, 'error' (with a
// sanitized message) on any throw, and the finally block backstops exotic
// exits so a row is never left 'running' by a caught failure.
export async function executeFullSync(runId: number, opts: { force?: boolean } = {}): Promise<SyncStats> {
  const stats: SyncStats = {
    playlistsSeen: 0,
    playlistsChanged: 0,
    tracksAdded: 0,
    tracksRemoved: 0,
    likedAdded: 0,
    likedRemoved: 0,
  };
  const ctx: SyncContext = { runId, stats, progress: emptyProgress() };

  let finalized = false;
  const finalize = (status: 'ok' | 'error', error?: string): void => {
    if (finalized) return;
    finalized = true;
    ctx.progress.currentPlaylist = null;
    finishRun(runId, status, stats, error, ctx.progress);
  };

  try {
    await syncPlaylists(ctx, opts.force === true);
    await syncLikedSongs(ctx);
    finalize('ok');
    return stats;
  } catch (err) {
    finalize('error', sanitizeErrorMessage(err));
    throw err;
  } finally {
    finalize('error', 'Sync ended without a result');
  }
}

async function syncPlaylists(ctx: SyncContext, force: boolean): Promise<void> {
  const me = await getCurrentUser();
  const seenIds = new Set<string>();

  // Materialize the playlist list up front so progress can report a total.
  const playlists: SpotifyPlaylist[] = [];
  for await (const pl of getAllPlaylists()) {
    if (!pl || !pl.id) continue;
    playlists.push(pl);
  }
  ctx.progress.counters.playlistsTotal = playlists.length + 1; // + Liked Songs
  updateRunProgress(ctx.runId, ctx.progress);

  for (const pl of playlists) {
    seenIds.add(pl.id);
    ctx.stats.playlistsSeen++;
    ctx.progress.currentPlaylist = { id: pl.id, name: pl.name };
    updateRunProgress(ctx.runId, ctx.progress);

    const existing = db()
      .prepare('SELECT name, snapshot_id FROM playlists WHERE id = ?')
      .get(pl.id) as { name: string; snapshot_id: string | null } | undefined;

    if (!force && existing && existing.snapshot_id === pl.snapshot_id) {
      db().prepare(`UPDATE playlists SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(pl.id);
      finishPlaylist(ctx, false);
      continue;
    }

    if (existing && existing.name !== pl.name) {
      logChange(ctx, 'playlist_renamed', { playlist_id: pl.id, details: { from: existing.name, to: pl.name } });
    }
    if (!existing) {
      logChange(ctx, 'playlist_added', { playlist_id: pl.id, details: { name: pl.name } });
    }

    ctx.stats.playlistsChanged++;
    upsertPlaylist(pl);
    const failed = await syncPlaylistTracks(ctx, pl);
    finishPlaylist(ctx, failed);
  }

  // Detect deleted playlists.
  const knownRows = db()
    .prepare('SELECT id, name FROM playlists WHERE is_liked_songs = 0')
    .all() as { id: string; name: string }[];
  for (const row of knownRows) {
    if (!seenIds.has(row.id)) {
      logChange(ctx, 'playlist_removed', { playlist_id: row.id, details: { name: row.name } });
      db().prepare('DELETE FROM playlists WHERE id = ?').run(row.id);
    }
  }

  void me;
}

// Marks one playlist as attempted and persists progress — the per-playlist
// checkpoint the status endpoint reads while a run is in flight.
function finishPlaylist(ctx: SyncContext, failed: boolean): void {
  ctx.progress.counters.playlistsProcessed++;
  if (failed) ctx.progress.counters.playlistsFailed++;
  updateRunProgress(ctx.runId, ctx.progress);
}

// Returns true if the playlist failed and was skipped (counted, run continues);
// unexpected errors propagate and abort the whole run.
async function syncPlaylistTracks(ctx: SyncContext, pl: SpotifyPlaylist): Promise<boolean> {
  const items: SpotifyPlaylistTrackItem[] = [];
  try {
    for await (const item of getPlaylistTracks(pl.id)) items.push(item);
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 403 || err.status === 404)) {
      console.warn(`[sync] skipping playlist ${pl.id} (${pl.name}): ${err.status} ${err.body}`);
      return true;
    }
    throw err;
  }

  const newRows: TrackRow[] = [];
  let pos = 0;
  for (const entry of items) {
    const track = entry.item ?? entry.track;
    if (!track || entry.is_local || !track.id) {
      pos++;
      continue;
    }
    upsertTrack(track);
    newRows.push({ track_id: track.id, position: pos, added_at: entry.added_at });
    pos++;
  }
  ctx.progress.counters.tracksProcessed += newRows.length;

  const oldRows = db()
    .prepare('SELECT track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ?')
    .all(pl.id) as TrackRow[];

  const oldSet = new Set(oldRows.map((r) => r.track_id));
  const newSet = new Set(newRows.map((r) => r.track_id));

  const tx = db().transaction(() => {
    db().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(pl.id);
    const ins = db().prepare(
      'INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)'
    );
    for (const r of newRows) ins.run(pl.id, r.track_id, r.position, r.added_at);
    db()
      .prepare(
        `UPDATE playlists SET track_count = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
      )
      .run(newRows.length, pl.id);
  });
  tx();

  for (const trackId of newSet) {
    if (!oldSet.has(trackId)) {
      ctx.stats.tracksAdded++;
      logChange(ctx, 'track_added_to_playlist', { playlist_id: pl.id, track_id: trackId });
    }
  }
  for (const trackId of oldSet) {
    if (!newSet.has(trackId)) {
      ctx.stats.tracksRemoved++;
      logChange(ctx, 'track_removed_from_playlist', { playlist_id: pl.id, track_id: trackId });
    }
  }
  return false;
}

async function syncLikedSongs(ctx: SyncContext): Promise<void> {
  ensureLikedPlaylistRow();
  ctx.progress.currentPlaylist = { id: LIKED_PLAYLIST_ID, name: 'Liked Songs' };
  updateRunProgress(ctx.runId, ctx.progress);

  const newRows: TrackRow[] = [];
  let pos = 0;
  for await (const item of getLikedTracks()) {
    if (!item.track || !item.track.id) {
      pos++;
      continue;
    }
    upsertTrack(item.track);
    newRows.push({ track_id: item.track.id, position: pos, added_at: item.added_at });
    pos++;
  }
  ctx.progress.counters.tracksProcessed += newRows.length;

  const oldRows = db()
    .prepare('SELECT track_id, position, added_at FROM playlist_tracks WHERE playlist_id = ?')
    .all(LIKED_PLAYLIST_ID) as TrackRow[];

  const oldSet = new Set(oldRows.map((r) => r.track_id));
  const newSet = new Set(newRows.map((r) => r.track_id));

  const tx = db().transaction(() => {
    db().prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(LIKED_PLAYLIST_ID);
    const ins = db().prepare(
      'INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)'
    );
    for (const r of newRows) ins.run(LIKED_PLAYLIST_ID, r.track_id, r.position, r.added_at);
    db()
      .prepare(
        `UPDATE playlists SET track_count = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
      )
      .run(newRows.length, LIKED_PLAYLIST_ID);
  });
  tx();

  for (const trackId of newSet) {
    if (!oldSet.has(trackId)) {
      ctx.stats.likedAdded++;
      logChange(ctx, 'track_liked', { playlist_id: LIKED_PLAYLIST_ID, track_id: trackId });
    }
  }
  for (const trackId of oldSet) {
    if (!newSet.has(trackId)) {
      ctx.stats.likedRemoved++;
      logChange(ctx, 'track_unliked', { playlist_id: LIKED_PLAYLIST_ID, track_id: trackId });
    }
  }
  finishPlaylist(ctx, false);
}

function ensureLikedPlaylistRow(): void {
  db()
    .prepare(
      `INSERT INTO playlists (id, name, is_liked_songs, track_count)
       VALUES (?, ?, 1, 0)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(LIKED_PLAYLIST_ID, 'Liked Songs');
}

function upsertPlaylist(pl: SpotifyPlaylist): void {
  db()
    .prepare(
      `INSERT INTO playlists (id, name, owner_id, owner_name, description, snapshot_id, is_liked_songs, track_count, public, collaborative, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         owner_id = excluded.owner_id,
         owner_name = excluded.owner_name,
         description = excluded.description,
         snapshot_id = excluded.snapshot_id,
         track_count = excluded.track_count,
         public = excluded.public,
         collaborative = excluded.collaborative,
         last_synced_at = excluded.last_synced_at`
    )
    .run(
      pl.id,
      pl.name,
      pl.owner?.id ?? null,
      pl.owner?.display_name ?? null,
      pl.description ?? null,
      pl.snapshot_id ?? null,
      pl.tracks?.total ?? 0,
      pl.public == null ? null : pl.public ? 1 : 0,
      pl.collaborative ? 1 : 0
    );
}

export function upsertTrack(t: SpotifyTrack): void {
  if (!t.id) return;
  db()
    .prepare(
      `INSERT INTO tracks (id, name, artist_names, album, duration_ms, isrc, explicit, popularity, preview_url, spotify_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         artist_names = excluded.artist_names,
         album = excluded.album,
         duration_ms = excluded.duration_ms,
         isrc = excluded.isrc,
         explicit = excluded.explicit,
         popularity = excluded.popularity,
         preview_url = excluded.preview_url,
         spotify_uri = excluded.spotify_uri`
    )
    .run(
      t.id,
      t.name,
      JSON.stringify(t.artists.map((a) => a.name)),
      t.album?.name ?? null,
      t.duration_ms,
      t.external_ids?.isrc ?? null,
      t.explicit ? 1 : 0,
      t.popularity ?? null,
      t.preview_url,
      t.uri
    );
}

function logChange(
  ctx: SyncContext,
  eventType: string,
  args: { playlist_id?: string; track_id?: string; details?: unknown }
): void {
  db()
    .prepare(
      `INSERT INTO changelog (event_type, playlist_id, track_id, details, sync_run_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      eventType,
      args.playlist_id ?? null,
      args.track_id ?? null,
      args.details === undefined ? null : JSON.stringify(args.details),
      ctx.runId
    );
  ctx.progress.counters.changesRecorded++;
}

export type SyncStats = {
  playlistsSeen: number;
  playlistsChanged: number;
  tracksAdded: number;
  tracksRemoved: number;
  likedAdded: number;
  likedRemoved: number;
};
