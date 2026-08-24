export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  stats TEXT,
  progress TEXT,
  owner_token TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT,
  owner_name TEXT,
  description TEXT,
  snapshot_id TEXT,
  is_liked_songs INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER NOT NULL DEFAULT 0,
  public INTEGER,
  collaborative INTEGER,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  artist_names TEXT NOT NULL,
  album TEXT,
  duration_ms INTEGER,
  isrc TEXT,
  explicit INTEGER,
  popularity INTEGER,
  preview_url TEXT,
  spotify_uri TEXT
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  added_at TEXT,
  added_by_user_id TEXT,
  PRIMARY KEY (playlist_id, position)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);

CREATE TABLE IF NOT EXISTS changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type TEXT NOT NULL,
  playlist_id TEXT,
  track_id TEXT,
  details TEXT,
  sync_run_id INTEGER REFERENCES sync_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_changelog_occurred ON changelog(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_changelog_playlist ON changelog(playlist_id);

CREATE TABLE IF NOT EXISTS play_events (
  track_id TEXT NOT NULL,
  played_at TEXT NOT NULL,
  context_type TEXT,
  context_uri TEXT,
  PRIMARY KEY (track_id, played_at)
);

CREATE INDEX IF NOT EXISTS idx_play_events_played ON play_events(played_at DESC);

CREATE TABLE IF NOT EXISTS play_counts (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id),
  total_plays INTEGER NOT NULL DEFAULT 0,
  first_played_at TEXT,
  last_played_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scope TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;
