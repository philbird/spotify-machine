# Spotify Machine

A self-hosted service that exports your Spotify playlists and Liked Songs to a local SQLite database, tracks every change over time as a changelog, and approximates per-track play counts.

It runs as a small Node app with a React UI. It's designed for personal use — one user, one machine, one DB file.

## Why

Spotify doesn't give you a way to:
- Take your library with you, in a queryable form.
- See what changed in your playlists over time (added, removed, renamed, re-liked).
- Know how often you've actually played a given track.

This bridges those gaps as best the public API allows.

## What it does

- **Mirrors your library to SQLite.** Every playlist (id, name, owner, snapshot, track membership) and Liked Songs goes into a single `data/spotify.db` file. Backups are just a file copy.
- **Records a changelog.** Every full sync diffs against the previous state and writes append-only events: `playlist_added`, `playlist_removed`, `playlist_renamed`, `track_added_to_playlist`, `track_removed_from_playlist`, `track_liked`, `track_unliked`.
- **Approximates play counts.** Polls `/me/player/recently-played` on a schedule and accumulates a per-track count + first/last timestamps.
- **Browses in a UI.** Dashboard, playlists list with detail view, changelog, and scheduler settings.

## The play-count caveat

Spotify's Web API does **not** expose lifetime per-track play counts. The closest endpoint returns only the **last 50 plays**. So:

- The play_counts table is **forward-only** — zero historical data, only what accumulates from poll time onward.
- Default poll interval is every 30 minutes. If you listen heavily, plays will be missed (50 tracks ≈ a few hours of typical listening).
- "Total plays" in the UI means *plays observed by this service since it started running*, not lifetime plays.

If that's a dealbreaker, this isn't the tool for you.

## Setup

Requires Node 20+.

1. **Create a Spotify app** at <https://developer.spotify.com/dashboard>. Register `http://127.0.0.1:8787/api/auth/callback` as a redirect URI. Copy the Client ID and Client Secret.

2. **Configure and install:**
   ```bash
   cp .env.example .env
   # fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
   npm install
   ```

3. **Run:**
   ```bash
   npm run dev          # API + scheduler on :8787
   npm run dev:web      # UI on :5173 (proxies /api → 8787)
   ```
   Or production: `npm run build && npm start` — Express serves the built UI on a single port.

4. **Connect.** Open <http://localhost:5173>, click **Connect Spotify**, complete OAuth, then **Full sync now**.

5. **Schedule it** (optional). On the Settings page, enable the scheduler. Defaults: full sync every 6 hours, plays poll every 30 minutes.

### One-shot CLI

```bash
npm run sync                # full sync
npm run sync -- plays       # plays poll only
npm run sync -- all         # both
npm run sync -- full --force  # bypass snapshot_id short-circuit and re-fetch all playlist tracks
```

## Full-sync job & status API

Full syncs run asynchronously with persisted, versioned progress:

- `POST /api/sync/full` claims a run atomically and responds **202** with `{ runId }` before any sync work starts; the sync runs in the background. If a full sync is already running (started from the API, the scheduler, or the CLI — they all share one guard), it responds **409** with `{ error, runId }` pointing at the active run.
- `GET /api/sync/status` returns `{ run }` for the **latest full-sync run in any state** (`running`, `ok`, `error`, `interrupted`), with `runId`, `startedAt`, `finishedAt`, `currentPlaylist`, stable counters (`playlistsTotal`, `playlistsProcessed`, `playlistsFailed`, `tracksProcessed`, `changesRecorded`), and a sanitized `error` summary. **If no full sync has ever been recorded (fresh database), it returns `200` with `{ "run": null }`** — there is no run history to report and clients should treat it as "nothing to show".
- `GET /api/sync/runs/:runId` returns the same shape for one specific run, so a client can keep following the run a POST returned even after a newer one starts.

Progress is checkpointed to the database after every playlist, so the Dashboard shows live progress (and survives page reloads). If the process dies mid-sync, the stale `running` row is marked `interrupted` at next startup; a failure during the sync finalizes the run as `error`. An individual playlist that Spotify refuses (403/404) is counted in `playlistsFailed` and the run continues; unexpected errors abort the whole run.

## Spotify API restrictions

Spotify locks down some endpoints for new third-party apps:

- **Followed playlists owned by other users** (e.g., editorial playlists like Discover Weekly, Daily Mix, or playlists made by other users you follow) return 403 on the tracks endpoint. Your own playlists work fine. The sync logs and skips them.
- **Track preview URLs** are no longer returned to apps registered after late 2024.

This is a Spotify policy, not a bug here.

## Architecture

```
src/
  config.ts              env loader
  index.ts               main entry — server + scheduler
  cli.ts                 one-shot entry
  db/                    schema (single SQL string), connection singleton
  spotify/               OAuth, fetch wrapper with 429 retry, paginators
  sync/                  full + plays sync, sync_runs bookkeeping
  scheduler/             node-cron, hot-reloads on settings change
  server/                express app + routes
web/
  src/pages/             Dashboard, Playlists, Changelog, Settings
```

- **Runtime:** Node 20+ TypeScript (ESM).
- **DB:** `better-sqlite3`. Schema is a single SQL string applied with `CREATE TABLE IF NOT EXISTS` on boot — no migration framework.
- **UI:** React + Vite. In dev, Vite serves on `:5173` and proxies `/api`. In prod, Express serves the built bundle.
- **Scheduler:** `node-cron`, in-process, controlled from the UI.
- **Spotify:** raw `fetch` against `api.spotify.com/v1`, no SDK.

For implementation detail and design decisions, see [CONTEXT.md](CONTEXT.md).

## Status / limitations

- Single-user, single-machine. **The DB stores your OAuth refresh token in plaintext** — treat the file like a credential. Don't expose this app to the internet without putting auth in front of it.
- Startup recovery preserves runs owned by a live local process and marks rows with a dead, missing, or legacy owner as `interrupted`.
- Tests: `npm test` (vitest) covers the sync job runner, the sync HTTP API, per-playlist progress, and Dashboard polling.

## License

Personal project, no license set. Use at your own risk.
