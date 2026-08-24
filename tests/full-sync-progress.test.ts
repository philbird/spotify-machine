import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-machine-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

type FakeTrackItem = { item?: unknown; track?: unknown; added_at: string | null; is_local?: boolean };

const control = vi.hoisted(() => ({
  playlists: [] as unknown[],
  tracksByPlaylist: {} as Record<string, unknown[]>,
  failPlaylistWith: {} as Record<string, unknown>,
  gate: null as { playlistId: string; promise: Promise<void> } | null,
  liked: [] as unknown[],
}));

vi.mock('../src/spotify/fetchers.js', () => ({
  getCurrentUser: async () => ({ id: 'user1', display_name: 'Test User' }),
  getAllPlaylists: async function* () {
    for (const p of control.playlists) yield p;
  },
  getPlaylistTracks: async function* (playlistId: string) {
    if (control.gate && control.gate.playlistId === playlistId) await control.gate.promise;
    if (control.failPlaylistWith[playlistId]) throw control.failPlaylistWith[playlistId];
    for (const t of control.tracksByPlaylist[playlistId] ?? []) yield t;
  },
  getLikedTracks: async function* () {
    for (const t of control.liked) yield t;
  },
  getRecentlyPlayed: async () => [],
}));

const { db, closeDb } = await import('../src/db/index.js');
const { executeFullSync } = await import('../src/sync/full.js');
const { SpotifyError } = await import('../src/spotify/client.js');
const runs = await import('../src/sync/runs.js');

function track(id: string): unknown {
  return {
    id,
    name: `Track ${id}`,
    artists: [{ name: 'Artist' }],
    album: { name: 'Album' },
    duration_ms: 1000,
    external_ids: {},
    explicit: false,
    popularity: 10,
    preview_url: null,
    uri: `spotify:track:${id}`,
  };
}

function trackItem(id: string): FakeTrackItem {
  return { item: track(id), added_at: '2026-01-01T00:00:00Z', is_local: false };
}

function playlist(id: string, name: string, snapshot = 's1'): unknown {
  return {
    id,
    name,
    snapshot_id: snapshot,
    owner: { id: 'user1', display_name: 'Test User' },
    description: null,
    tracks: { total: 0 },
    public: true,
    collaborative: false,
  };
}

function getProgress(runId: number): runs.SyncProgress {
  return runs.parseProgress(runs.getRunById(runId)?.progress ?? null);
}

afterEach(() => {
  control.playlists = [];
  control.tracksByPlaylist = {};
  control.failPlaylistWith = {};
  control.gate = null;
  control.liked = [];
  for (const table of ['changelog', 'playlist_tracks', 'playlists', 'tracks', 'sync_runs']) {
    db().prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('executeFullSync progress', () => {
  it('persists progress after each playlist while the run is still going', async () => {
    control.playlists = [playlist('pl1', 'First'), playlist('pl2', 'Second')];
    control.tracksByPlaylist = { pl1: [trackItem('t1'), trackItem('t2')], pl2: [trackItem('t3')] };
    control.liked = [{ track: track('t4'), added_at: '2026-01-02T00:00:00Z' }];
    let release!: () => void;
    control.gate = { playlistId: 'pl2', promise: new Promise((r) => (release = r)) };

    const runId = runs.startRun('full');
    const run = executeFullSync(runId);

    // Wait until playlist 1's checkpoint lands, while playlist 2 is blocked.
    await waitFor(() => getProgress(runId).counters.playlistsProcessed === 1);
    const mid = getProgress(runId);
    expect(mid.counters.playlistsTotal).toBe(3); // 2 playlists + Liked Songs
    expect(mid.counters.tracksProcessed).toBe(2);
    expect(mid.currentPlaylist).toEqual({ id: 'pl2', name: 'Second' });
    expect(runs.getRunById(runId)?.status).toBe('running');

    release();
    const stats = await run;
    expect(stats.playlistsSeen).toBe(2);

    const row = runs.getRunById(runId);
    expect(row?.status).toBe('ok');
    expect(row?.finished_at).not.toBeNull();
    const final = getProgress(runId);
    expect(final.currentPlaylist).toBeNull();
    expect(final.counters).toEqual({
      playlistsTotal: 3,
      playlistsProcessed: 3,
      playlistsFailed: 0,
      tracksProcessed: 4,
      // 2 playlist_added + 3 track_added_to_playlist + 1 track_liked
      changesRecorded: 6,
    });
  });

  it('finalizes as error with a sanitized message and keeps progress made so far', async () => {
    control.playlists = [playlist('pl1', 'First'), playlist('pl2', 'Second')];
    control.tracksByPlaylist = { pl1: [trackItem('t1')] };
    control.failPlaylistWith = { pl2: new Error('network died, Bearer sekrit-token leaked') };

    const runId = runs.startRun('full');
    await expect(executeFullSync(runId)).rejects.toThrow('network died');

    const row = runs.getRunById(runId);
    expect(row?.status).toBe('error');
    expect(row?.finished_at).not.toBeNull();
    expect(row?.error).toContain('Bearer [redacted]');
    expect(row?.error).not.toContain('sekrit-token');

    // Playlist 1's checkpoint survived the failure.
    const progress = getProgress(runId);
    expect(progress.counters.playlistsProcessed).toBe(1);
    expect(progress.counters.tracksProcessed).toBe(1);
    expect(progress.currentPlaylist).toBeNull();
  });

  it('counts an individual playlist 403 as failed and completes the run', async () => {
    control.playlists = [playlist('pl1', 'First'), playlist('pl2', 'Forbidden')];
    control.tracksByPlaylist = { pl1: [trackItem('t1')] };
    control.failPlaylistWith = { pl2: new SpotifyError(403, 'forbidden', 'https://api.spotify.com/x') };

    const runId = runs.startRun('full');
    await executeFullSync(runId);

    const row = runs.getRunById(runId);
    expect(row?.status).toBe('ok');
    const progress = getProgress(runId);
    expect(progress.counters.playlistsProcessed).toBe(3);
    expect(progress.counters.playlistsFailed).toBe(1);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met within timeout');
}
