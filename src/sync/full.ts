import { db } from '../db/index.js';
import { getAllPlaylists, getCurrentUser, getLikedTracks, getPlaylistTracks } from '../spotify/fetchers.js';
import type { SpotifyPlaylist, SpotifyPlaylistTrackItem, SpotifyTrack } from '../spotify/types.js';
import { finishRun, startRun } from './runs.js';

const LIKED_PLAYLIST_ID = '__liked__';

type TrackRow = { track_id: string; position: number; added_at: string | null };

export async function runFullSync(): Promise<{ runId: number; stats: SyncStats }> {
  const runId = startRun('full');
  const stats: SyncStats = {
    playlistsSeen: 0,
    playlistsChanged: 0,
    tracksAdded: 0,
    tracksRemoved: 0,
    likedAdded: 0,
    likedRemoved: 0,
  };

  try {
    await syncPlaylists(runId, stats);
    await syncLikedSongs(runId, stats);
    finishRun(runId, 'ok', stats);
    return { runId, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishRun(runId, 'error', stats, message);
    throw err;
  }
}

async function syncPlaylists(runId: number, stats: SyncStats): Promise<void> {
  const me = await getCurrentUser();
  const seenIds = new Set<string>();

  for await (const pl of getAllPlaylists()) {
    seenIds.add(pl.id);
    stats.playlistsSeen++;

    const existing = db()
      .prepare('SELECT name, snapshot_id FROM playlists WHERE id = ?')
      .get(pl.id) as { name: string; snapshot_id: string | null } | undefined;

    if (existing && existing.snapshot_id === pl.snapshot_id) {
      db().prepare(`UPDATE playlists SET last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(pl.id);
      continue;
    }

    if (existing && existing.name !== pl.name) {
      logChange(runId, 'playlist_renamed', { playlist_id: pl.id, details: { from: existing.name, to: pl.name } });
    }
    if (!existing) {
      logChange(runId, 'playlist_added', { playlist_id: pl.id, details: { name: pl.name } });
    }

    stats.playlistsChanged++;
    upsertPlaylist(pl);
    await syncPlaylistTracks(runId, pl, stats);
  }

  // Detect deleted playlists.
  const knownRows = db()
    .prepare('SELECT id, name FROM playlists WHERE is_liked_songs = 0')
    .all() as { id: string; name: string }[];
  for (const row of knownRows) {
    if (!seenIds.has(row.id)) {
      logChange(runId, 'playlist_removed', { playlist_id: row.id, details: { name: row.name } });
      db().prepare('DELETE FROM playlists WHERE id = ?').run(row.id);
    }
  }

  void me;
}

async function syncPlaylistTracks(runId: number, pl: SpotifyPlaylist, stats: SyncStats): Promise<void> {
  const items: SpotifyPlaylistTrackItem[] = [];
  for await (const item of getPlaylistTracks(pl.id)) items.push(item);

  const newRows: TrackRow[] = [];
  let pos = 0;
  for (const item of items) {
    if (!item.track || item.is_local || !item.track.id) {
      pos++;
      continue;
    }
    upsertTrack(item.track);
    newRows.push({ track_id: item.track.id, position: pos, added_at: item.added_at });
    pos++;
  }

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
      stats.tracksAdded++;
      logChange(runId, 'track_added_to_playlist', { playlist_id: pl.id, track_id: trackId });
    }
  }
  for (const trackId of oldSet) {
    if (!newSet.has(trackId)) {
      stats.tracksRemoved++;
      logChange(runId, 'track_removed_from_playlist', { playlist_id: pl.id, track_id: trackId });
    }
  }
}

async function syncLikedSongs(runId: number, stats: SyncStats): Promise<void> {
  ensureLikedPlaylistRow();

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
      stats.likedAdded++;
      logChange(runId, 'track_liked', { playlist_id: LIKED_PLAYLIST_ID, track_id: trackId });
    }
  }
  for (const trackId of oldSet) {
    if (!newSet.has(trackId)) {
      stats.likedRemoved++;
      logChange(runId, 'track_unliked', { playlist_id: LIKED_PLAYLIST_ID, track_id: trackId });
    }
  }
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
      pl.owner.id,
      pl.owner.display_name,
      pl.description,
      pl.snapshot_id,
      pl.tracks.total,
      pl.public === null ? null : pl.public ? 1 : 0,
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
  runId: number,
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
      runId
    );
}

export type SyncStats = {
  playlistsSeen: number;
  playlistsChanged: number;
  tracksAdded: number;
  tracksRemoved: number;
  likedAdded: number;
  likedRemoved: number;
};
