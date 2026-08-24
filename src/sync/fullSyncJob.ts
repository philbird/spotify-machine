import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { executeFullSync, type SyncStats } from './full.js';
import {
  finishRun,
  getLatestRunOfKind,
  getRunById,
  parseProgress,
  sanitizeErrorMessage,
  type RunStatus,
  type SyncCounters,
  type SyncRunRow,
} from './runs.js';

// Identifies runs created by this process. Any persisted 'running' row with a
// different (or missing) token cannot belong to us and is recovered as
// 'interrupted' at startup.
export const PROCESS_TOKEN = `pid:${process.pid}:${randomUUID()}`;

export type StartFullSyncResult =
  | { started: true; runId: number; completion: Promise<SyncStats> }
  | { started: false; runId: number };

type FullSyncExecutor = (runId: number, opts: { force?: boolean }) => Promise<SyncStats>;

let executor: FullSyncExecutor = executeFullSync;

// Test seam: lets tests observe/gate the async work without real Spotify calls.
export function setFullSyncExecutorForTests(fn: FullSyncExecutor | null): void {
  executor = fn ?? executeFullSync;
}

// Marks persisted 'running' rows that cannot belong to this process as
// 'interrupted'. Call once at process startup, before any job can be started.
//
// PID-bearing owner tokens let another local server/CLI process retain its
// active claim. Missing and legacy tokens are conservatively treated as stale.
export function recoverInterruptedRuns(): number {
  const rows = db()
    .prepare(`SELECT id, owner_token FROM sync_runs WHERE status = 'running' AND (owner_token IS NULL OR owner_token != ?)`)
    .all(PROCESS_TOKEN) as { id: number; owner_token: string | null }[];
  const staleIds = rows.filter((row) => !ownerProcessIsAlive(row.owner_token)).map((row) => row.id);
  if (staleIds.length === 0) return 0;

  const markInterrupted = db().prepare(
    `UPDATE sync_runs
     SET status = 'interrupted',
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         error = 'Interrupted: the process ended before this run finished'
     WHERE id = ? AND status = 'running'`
  );
  const tx = db().transaction(() => staleIds.reduce((changed, id) => changed + markInterrupted.run(id).changes, 0));
  const changed = tx.immediate();
  if (changed > 0) console.warn(`[sync] recovered ${changed} stale running sync run(s) as interrupted`);
  return changed;
}

function ownerProcessIsAlive(token: string | null): boolean {
  const match = token?.match(/^pid:(\d+):/);
  if (!match) return false; // legacy/missing ownership cannot belong to a live process we can identify
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still means the process exists, just under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Atomically either claims a new running full-sync row or reports the id of
// the one already running. better-sqlite3 transactions are synchronous, so
// two in-process callers can never interleave here; the immediate transaction
// additionally takes the SQLite write lock up front, making the database the
// concurrency authority across processes sharing the file.
function claimFullSyncRun(): { claimed: boolean; runId: number } {
  const tx = db().transaction(() => {
    const active = db()
      .prepare(`SELECT id FROM sync_runs WHERE kind = 'full' AND status = 'running' ORDER BY id DESC LIMIT 1`)
      .get() as { id: number } | undefined;
    if (active) return { claimed: false, runId: active.id };
    const info = db()
      .prepare(`INSERT INTO sync_runs (kind, status, owner_token) VALUES ('full', 'running', ?)`)
      .run(PROCESS_TOKEN);
    return { claimed: true, runId: Number(info.lastInsertRowid) };
  });
  return tx.immediate();
}

// Starts a full sync asynchronously. The run row is claimed synchronously
// (so the caller can respond with the runId immediately) and the actual sync
// work begins on the next event-loop turn — never before this returns.
//
// All full-sync entry points (HTTP route, scheduler, CLI) must go through
// this function so they share one exclusivity guard.
export function startFullSyncJob(opts: { force?: boolean } = {}): StartFullSyncResult {
  const claim = claimFullSyncRun();
  if (!claim.claimed) return { started: false, runId: claim.runId };

  const runId = claim.runId;
  const completion = (async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      return await executor(runId, opts);
    } finally {
      // executeFullSync finalizes its own row; this backstop covers injected
      // executors and any path that dies before finalization, so a caught
      // failure can never leave the row 'running'.
      const row = getRunById(runId);
      if (row && row.status === 'running') {
        finishRun(runId, 'error', {}, 'Sync ended without a result');
      }
    }
  })();
  return { started: true, runId, completion };
}

export function isFullSyncRunning(): boolean {
  return (
    db().prepare(`SELECT 1 FROM sync_runs WHERE kind = 'full' AND status = 'running' LIMIT 1`).get() !== undefined
  );
}

export type FullSyncStatus = {
  runId: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  currentPlaylist: { id: string; name: string } | null;
  counters: SyncCounters;
  error: string | null;
};

export function toFullSyncStatus(row: SyncRunRow): FullSyncStatus {
  const progress = parseProgress(row.progress);
  const status: RunStatus =
    row.status === 'running' || row.status === 'ok' || row.status === 'error' || row.status === 'interrupted'
      ? row.status
      : 'error';
  return {
    runId: row.id,
    status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    currentPlaylist: status === 'running' ? progress.currentPlaylist : null,
    counters: progress.counters,
    // Re-sanitize on read so rows written before sanitization existed are safe.
    error: row.error == null ? null : sanitizeErrorMessage(row.error),
  };
}

// Latest persisted full-sync run in any state, or null if none has ever run.
export function getFullSyncStatus(): FullSyncStatus | null {
  const row = getLatestRunOfKind('full');
  return row ? toFullSyncStatus(row) : null;
}
