import { db } from '../db/index.js';

export type SyncKind = 'full' | 'plays';

export function startRun(kind: SyncKind): number {
  const info = db().prepare(`INSERT INTO sync_runs (kind) VALUES (?)`).run(kind);
  return Number(info.lastInsertRowid);
}

export function finishRun(id: number, status: 'ok' | 'error', stats: Record<string, unknown>, error?: string): void {
  db()
    .prepare(
      `UPDATE sync_runs
       SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           status = ?,
           error = ?,
           stats = ?
       WHERE id = ?`
    )
    .run(status, error ?? null, JSON.stringify(stats), id);
}

export type SyncRunRow = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  stats: string | null;
};

export function getRecentRuns(limit = 20): SyncRunRow[] {
  return db().prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?').all(limit) as SyncRunRow[];
}

export function getLastRunOfKind(kind: SyncKind): SyncRunRow | null {
  return (db()
    .prepare('SELECT * FROM sync_runs WHERE kind = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .get(kind, 'ok') as SyncRunRow | undefined) ?? null;
}
