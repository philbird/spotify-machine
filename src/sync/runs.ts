import { db } from '../db/index.js';

export type SyncKind = 'full' | 'plays';
export type RunStatus = 'running' | 'ok' | 'error' | 'interrupted';

// Versioned progress payload persisted in sync_runs.progress. Bump `version`
// (and handle old shapes in parseProgress) if the schema ever changes.
export type SyncCounters = {
  // Total playlists to process, including the synthetic Liked Songs playlist.
  // null until the playlist list has been enumerated.
  playlistsTotal: number | null;
  // Playlists attempted so far (successes and failures both count).
  playlistsProcessed: number;
  // Subset of playlistsProcessed that failed and were skipped.
  playlistsFailed: number;
  tracksProcessed: number;
  changesRecorded: number;
};

export type SyncProgress = {
  version: 1;
  currentPlaylist: { id: string; name: string } | null;
  counters: SyncCounters;
};

export function emptyProgress(): SyncProgress {
  return {
    version: 1,
    currentPlaylist: null,
    counters: {
      playlistsTotal: null,
      playlistsProcessed: 0,
      playlistsFailed: 0,
      tracksProcessed: 0,
      changesRecorded: 0,
    },
  };
}

export function parseProgress(raw: string | null): SyncProgress {
  if (!raw) return emptyProgress();
  try {
    const parsed = JSON.parse(raw) as SyncProgress;
    if (parsed && parsed.version === 1 && parsed.counters) return parsed;
  } catch {
    // fall through to empty
  }
  return emptyProgress();
}

export function startRun(kind: SyncKind, ownerToken?: string): number {
  const info = db()
    .prepare(`INSERT INTO sync_runs (kind, owner_token) VALUES (?, ?)`)
    .run(kind, ownerToken ?? null);
  return Number(info.lastInsertRowid);
}

export function updateRunProgress(id: number, progress: SyncProgress): void {
  db().prepare(`UPDATE sync_runs SET progress = ? WHERE id = ?`).run(JSON.stringify(progress), id);
}

export function finishRun(
  id: number,
  status: 'ok' | 'error',
  stats: Record<string, unknown>,
  error?: string,
  progress?: SyncProgress
): void {
  db()
    .prepare(
      `UPDATE sync_runs
       SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           status = ?,
           error = ?,
           stats = ?,
           progress = COALESCE(?, progress)
       WHERE id = ?`
    )
    .run(status, error ?? null, JSON.stringify(stats), progress ? JSON.stringify(progress) : null, id);
}

// Error messages can embed request URLs or API bodies; strip anything
// credential-shaped and cap the length before it is persisted or served.
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /(access_token|refresh_token|client_secret|code|token)(["']?\s*[=:]\s*["']?)[^&\s,"'}]+/gi,
      '$1$2[redacted]'
    )
    .trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}…` : cleaned;
}

export type SyncRunRow = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  stats: string | null;
  progress: string | null;
  owner_token: string | null;
};

export function getRecentRuns(limit = 20): SyncRunRow[] {
  return db().prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').all(limit) as SyncRunRow[];
}

export function getRunById(id: number): SyncRunRow | null {
  return (db().prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as SyncRunRow | undefined) ?? null;
}

export function getLastRunOfKind(kind: SyncKind): SyncRunRow | null {
  return (db()
    .prepare('SELECT * FROM sync_runs WHERE kind = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .get(kind, 'ok') as SyncRunRow | undefined) ?? null;
}

// Latest run of a kind in any state (running/ok/error/interrupted). Ordered by
// id: unlike started_at it is unique, so same-millisecond runs sort stably.
export function getLatestRunOfKind(kind: SyncKind): SyncRunRow | null {
  return (db()
    .prepare('SELECT * FROM sync_runs WHERE kind = ? ORDER BY id DESC LIMIT 1')
    .get(kind) as SyncRunRow | undefined) ?? null;
}
