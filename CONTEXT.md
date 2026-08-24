# Spotify Machine — handoff context

A personal service that exports Spotify playlists + Liked Songs to a SQLite database, with a changelog of every change over time and approximate play counts.

This file exists so a fresh Claude session on another machine can pick up where we left off. Read it first, then explore the code.

## Decisions already made (don't re-litigate)

- **Runtime:** Node 20+ with TypeScript (ESM, `"type": "module"`).
- **DB:** `better-sqlite3`, single file at `data/spotify.db`. Chosen so backups are just a file copy.
- **UI:** React + Vite, served by the Express server in production. In dev, Vite runs on `:5173` and proxies `/api` to `:8787`.
- **Scheduler:** `node-cron`, in-process. Toggled via the UI; settings stored in the `settings` table.
- **Run modes:** both supported — scheduled (in-process cron) and one-shot (`npm run sync`).
- **Token storage:** OAuth refresh token lives in SQLite (`oauth_tokens` table). User accepted the tradeoff: the DB file is sensitive, treat backups accordingly.
- **No ORM, no migration framework.** Schema is a single SQL string in [src/db/schema.ts](src/db/schema.ts), applied with `CREATE TABLE IF NOT EXISTS` on every boot. Add new tables/indexes the same way; for destructive changes, write a one-off migration script.
- **No external SDK for Spotify.** Raw `fetch` against `api.spotify.com/v1`. The 429 retry + pagination live in [src/spotify/client.ts](src/spotify/client.ts).

## The play-count caveat (important)

Spotify's Web API does **not** expose per-track play counts. The closest endpoint is `/me/player/recently-played`, which returns the last **50** plays only. So:

- The `play_counts` table is forward-only — it has zero historical data and only accumulates from poll time onward.
- Default poll interval is every 30 min. If the user listens heavily, plays will be missed (50 tracks ≈ a few hours of typical listening).
- "Total plays" in the UI means "plays observed by this service since it started running," not lifetime plays.

If a future user complains the counts are low, this is why.

## Architecture at a glance

```
src/
  config.ts              # env loader (SPOTIFY_CLIENT_ID/SECRET, DATABASE_PATH, PORT)
  index.ts               # main entry — starts server + applies schedule
  cli.ts                 # one-shot entry — `npm run sync -- [full|plays|all]`
  db/
    schema.ts            # all DDL as a single SQL string
    index.ts             # singleton connection, applies schema on first call
    settings.ts          # typed get/update over the settings k/v table
  spotify/
    auth.ts              # OAuth code flow, token store, refresh-on-demand
    client.ts            # fetch wrapper with 429 retry, generic paginate()
    fetchers.ts          # /me, /me/playlists, /playlists/:id/tracks, /me/tracks, /me/player/recently-played
    types.ts             # API response types
  sync/
    full.ts              # playlists + Liked Songs sync, snapshot_id short-circuit, diff → changelog
    plays.ts             # recently-played poll, upserts play_events + play_counts
    runs.ts              # sync_runs table helpers (start/finish/list)
  scheduler/
    index.ts             # node-cron, applySchedule() called on boot and on settings change
  server/
    index.ts             # express app, mounts routes, serves built UI
    routes/
      auth.ts            # /api/auth/{login,callback,status,disconnect}
      sync.ts            # /api/sync/{full,plays,runs,inflight} — POSTs are mutex'd
      settings.ts        # /api/settings GET/PUT, calls applySchedule on change
      dashboard.ts       # /api/dashboard — counts + last run summaries
      changelog.ts       # /api/changelog — joined with playlist + track names
      playlists.ts       # /api/playlists, /api/playlists/:id/tracks
web/
  index.html, vite.config.ts, tsconfig.json
  src/
    main.tsx, App.tsx, api.ts, styles.css
    pages/Dashboard.tsx     # connect, counts, sync-now buttons, last-run timestamps
    pages/Settings.tsx      # scheduler toggle + cron expressions
    pages/Changelog.tsx     # latest 200 events
```

## Database schema (current)

All tables in [src/db/schema.ts](src/db/schema.ts). Summary:

- `playlists` — keyed by Spotify id. Stores `snapshot_id` so we can skip unchanged playlists on re-sync. Liked Songs is a synthetic playlist with id `__liked__` and `is_liked_songs = 1`.
- `tracks` — keyed by Spotify id. `artist_names` is a JSON array of strings.
- `playlist_tracks` — composite PK `(playlist_id, position)`. This handles duplicates (same track twice in one playlist at different positions). On full sync we DELETE+INSERT all rows for a changed playlist inside a transaction.
- `changelog` — append-only event log. Event types: `playlist_added`, `playlist_removed`, `playlist_renamed`, `track_added_to_playlist`, `track_removed_from_playlist`, `track_liked`, `track_unliked`. Each row has a `sync_run_id` FK back to `sync_runs`.
- `play_events` — PK `(track_id, played_at)` for natural dedupe across overlapping polls.
- `play_counts` — denormalized total + first/last timestamps. Updated incrementally inside the plays-poll transaction.
- `sync_runs` — one row per sync attempt (`kind: 'full' | 'plays'`), with stats JSON.
- `settings` — k/v for scheduler config. Keys: `schedulerEnabled`, `fullSyncCron`, `playsPollCron`.
- `oauth_tokens` — single row, PK `id = 1`. Holds access + refresh + expiry.

## How sync works

**Full sync** ([src/sync/full.ts](src/sync/full.ts)):
1. Open a `sync_runs` row.
2. Fetch all playlists. For each, compare `snapshot_id` to stored — if same, just touch `last_synced_at` and skip.
3. For changed playlists: fetch all tracks (paginated 100/page), upsert tracks, replace `playlist_tracks` rows for that playlist in a transaction, then diff old vs. new track sets and emit changelog rows.
4. Detect deleted playlists by tracking which ids we saw and removing the rest (skipping `is_liked_songs = 1`).
5. Same flow for Liked Songs against the `__liked__` synthetic playlist, but emits `track_liked` / `track_unliked` instead of add/remove events.
6. Close `sync_runs` with `ok` or `error`.

**Plays poll** ([src/sync/plays.ts](src/sync/plays.ts)):
1. Read `MAX(played_at)` from `play_events` to use as the `after=` cursor.
2. Fetch up to 50 most recent plays.
3. Insert into `play_events` with `ON CONFLICT DO NOTHING`.
4. For each newly inserted event, increment `play_counts` (creating the row if needed).

`POST /api/sync/full` responds 202 immediately and runs the sync in the background through `src/sync/fullSyncJob.ts` — a single exclusive in-process runner whose claim is an atomic SQLite transaction (the DB is the concurrency authority; the API, scheduler, and CLI all share it, and a busy start yields 409/skip with the active runId). Progress (versioned JSON: currentPlaylist + counters) is persisted to `sync_runs.progress` after every playlist and served by `GET /api/sync/status` (returns `{ run: null }` if no full sync was ever recorded) and `GET /api/sync/runs/:runId`. Stale `running` rows are marked `interrupted` at process startup. `POST /api/sync/plays` remains synchronous behind an in-memory mutex and also 409s while a full sync runs.

## Running it

```bash
cd "SpotifyMachine"
cp .env.example .env
# fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
# (create app at https://developer.spotify.com/dashboard)
# register http://127.0.0.1:8787/api/auth/callback as a redirect URI

npm install            # better-sqlite3 has prebuilt binaries for darwin/linux
npm run dev            # API + scheduler on :8787
npm run dev:web        # UI on :5173 (proxies /api → 8787)
# OR
npm run sync           # one-shot full sync from CLI
npm run sync -- plays  # one-shot plays poll
npm run sync -- all    # both
```

For prod: `npm run build` then `npm start` — Express serves the built UI from one port.

Required scopes (already wired in [src/config.ts](src/config.ts)): `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `user-read-recently-played`, `user-read-playback-state`.

## Status: what's done vs. what's not

**Done:**
- Full project scaffold, all backend modules, all 3 UI pages.
- OAuth flow end-to-end (login URL, callback, refresh).
- Full sync with diff → changelog and snapshot short-circuit.
- Plays poll with dedupe + `play_counts`.
- Scheduler with hot-reload on settings change.
- CLI one-shot.
- Mutex on sync endpoints.

**Not yet:**
- Never been run end-to-end on a real Spotify account. Code has not been executed yet — typecheck/install/sync untested. Expect minor fixes on first run.
- No `Browse playlists` page in the UI (the `/api/playlists` endpoints exist; just need a page).
- No graceful shutdown — `closeDb()` exists but isn't wired to SIGTERM/SIGINT in the server entry.
- No CSRF on the OAuth state — `pendingStates` is an in-memory Set in [src/server/routes/auth.ts](src/server/routes/auth.ts), which is fine for a single-user local app but not for anything multi-tenant.

## First things to do on the new machine

1. `npm install` and resolve any `better-sqlite3` build issues (darwin arm64 + linux x64 have prebuilds; otherwise needs Python + a C++ toolchain).
2. `npm run typecheck` — likely catches at least one type issue I didn't run.
3. Create a Spotify app, fill `.env`, click "Connect Spotify" in the UI, then "Full sync now."
4. Inspect `data/spotify.db` with `sqlite3` to confirm tables populated as expected.
5. Then turn on scheduled mode and watch the plays poll accumulate.

## Things to be careful about

- The `playlist_tracks` PK is `(playlist_id, position)` — **not** `(playlist_id, track_id)`. This is intentional: a playlist can legitimately contain the same track twice. If you ever want a "is this track in this playlist" query, you need a `WHERE` not a PK lookup.
- `snapshot_id` in Spotify changes on **any** playlist mutation (reorder, edit description, add/remove). So skipping when it matches is safe; you won't miss changes.
- The `MIN`/`MAX` over ISO-8601 strings in the `play_counts` upsert relies on lexicographic sort matching chronological sort. Always use UTC ISO format (`Z` suffix) — don't switch to local time.
- `applySchedule()` calls `.stop()` on existing tasks before recreating them. Don't change this to skip-if-unchanged unless you also handle the case where cron expressions changed.
