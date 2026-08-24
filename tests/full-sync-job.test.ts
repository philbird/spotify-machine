import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-machine-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const { db, closeDb } = await import('../src/db/index.js');
const job = await import('../src/sync/fullSyncJob.js');
const runs = await import('../src/sync/runs.js');

const okStats = () => ({
  playlistsSeen: 0,
  playlistsChanged: 0,
  tracksAdded: 0,
  tracksRemoved: 0,
  likedAdded: 0,
  likedRemoved: 0,
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => {
  job.setFullSyncExecutorForTests(null);
  db().prepare('DELETE FROM changelog').run();
  db().prepare('DELETE FROM sync_runs').run();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startFullSyncJob', () => {
  it('registers the run and returns before any sync work starts', async () => {
    const gate = deferred();
    let workStarted = false;
    job.setFullSyncExecutorForTests(async (runId) => {
      workStarted = true;
      await gate.promise;
      runs.finishRun(runId, 'ok', okStats());
      return okStats();
    });

    const result = job.startFullSyncJob();
    expect(result.started).toBe(true);
    // The claim is visible immediately, but no sync work has run yet.
    expect(workStarted).toBe(false);
    const row = runs.getRunById(result.runId);
    expect(row?.status).toBe('running');

    await nextTurn();
    expect(workStarted).toBe(true);

    gate.resolve();
    if (result.started) await result.completion;
    expect(runs.getRunById(result.runId)?.status).toBe('ok');
  });

  it('rejects a second start while one is running, reporting the active runId', async () => {
    const gate = deferred();
    job.setFullSyncExecutorForTests(async (runId) => {
      await gate.promise;
      runs.finishRun(runId, 'ok', okStats());
      return okStats();
    });

    const first = job.startFullSyncJob();
    const second = job.startFullSyncJob();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.runId).toBe(first.runId);
    // Only one running row exists.
    const running = db().prepare(`SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'running'`).get() as { n: number };
    expect(running.n).toBe(1);

    gate.resolve();
    if (first.started) await first.completion;

    // After the run finishes, a new start is accepted again.
    job.setFullSyncExecutorForTests(async (runId) => {
      runs.finishRun(runId, 'ok', okStats());
      return okStats();
    });
    const third = job.startFullSyncJob();
    expect(third.started).toBe(true);
    expect(third.runId).not.toBe(first.runId);
    if (third.started) await third.completion;
  });

  it('finalizes the run as error when the executor throws without finalizing', async () => {
    job.setFullSyncExecutorForTests(async () => {
      throw new Error('boom');
    });
    const result = job.startFullSyncJob();
    expect(result.started).toBe(true);
    if (!result.started) return;
    await expect(result.completion).rejects.toThrow('boom');
    const row = runs.getRunById(result.runId);
    expect(row?.status).toBe('error');
    expect(row?.finished_at).not.toBeNull();
  });
});

describe('recoverInterruptedRuns', () => {
  it('marks running rows from other processes as interrupted, leaving own rows alone', () => {
    const insert = db().prepare(`INSERT INTO sync_runs (kind, status, owner_token) VALUES (?, 'running', ?)`);
    const stale = Number(insert.run('full', 'dead-process-token').lastInsertRowid);
    const legacy = Number(insert.run('plays', null).lastInsertRowid);
    const mine = Number(insert.run('full', job.PROCESS_TOKEN).lastInsertRowid);
    const finished = Number(
      db()
        .prepare(`INSERT INTO sync_runs (kind, status, owner_token) VALUES ('full', 'ok', 'dead-process-token')`)
        .run().lastInsertRowid
    );

    const changed = job.recoverInterruptedRuns();
    expect(changed).toBe(2);
    expect(runs.getRunById(stale)?.status).toBe('interrupted');
    expect(runs.getRunById(stale)?.finished_at).not.toBeNull();
    expect(runs.getRunById(legacy)?.status).toBe('interrupted');
    expect(runs.getRunById(mine)?.status).toBe('running');
    expect(runs.getRunById(finished)?.status).toBe('ok');
  });

  it('does not recover a run owned by another live local process', () => {
    const liveOwner = `pid:${process.pid}:another-process-token`;
    const id = Number(
      db().prepare(`INSERT INTO sync_runs (kind, status, owner_token) VALUES ('full', 'running', ?)`).run(liveOwner)
        .lastInsertRowid
    );

    expect(job.recoverInterruptedRuns()).toBe(0);
    expect(runs.getRunById(id)?.status).toBe('running');
    expect(job.startFullSyncJob()).toEqual({ started: false, runId: id });
  });
});

describe('getFullSyncStatus', () => {
  it('returns null when no full sync has ever run', () => {
    expect(job.getFullSyncStatus()).toBeNull();
    // plays runs do not count as full-sync history
    db().prepare(`INSERT INTO sync_runs (kind, status) VALUES ('plays', 'ok')`).run();
    expect(job.getFullSyncStatus()).toBeNull();
  });

  it('maps the latest run with counters and sanitizes persisted errors', () => {
    const progress: import('../src/sync/runs.js').SyncProgress = {
      version: 1,
      currentPlaylist: { id: 'pl1', name: 'Road Trip' },
      counters: {
        playlistsTotal: 10,
        playlistsProcessed: 4,
        playlistsFailed: 1,
        tracksProcessed: 123,
        changesRecorded: 7,
      },
    };
    db()
      .prepare(
        `INSERT INTO sync_runs (kind, status, finished_at, error, progress)
         VALUES ('full', 'error', '2026-08-24T00:00:00.000Z', ?, ?)`
      )
      .run('failed with Bearer super-secret-token attached', JSON.stringify(progress));

    const status = job.getFullSyncStatus();
    expect(status).not.toBeNull();
    expect(status?.status).toBe('error');
    expect(status?.finishedAt).toBe('2026-08-24T00:00:00.000Z');
    expect(status?.counters).toEqual(progress.counters);
    // currentPlaylist only surfaces while running
    expect(status?.currentPlaylist).toBeNull();
    expect(status?.error).toContain('Bearer [redacted]');
    expect(status?.error).not.toContain('super-secret-token');
  });

  it('redacts credential values embedded in structured error text', () => {
    expect(runs.sanitizeErrorMessage('{"access_token":"secret-value","message":"nope"}')).toBe(
      '{"access_token":"[redacted]","message":"nope"}'
    );
  });

  it('surfaces currentPlaylist and zeroed counters for a running run without progress yet', () => {
    const id = Number(
      db().prepare(`INSERT INTO sync_runs (kind, status, owner_token) VALUES ('full', 'running', 'x')`).run()
        .lastInsertRowid
    );
    const status = job.getFullSyncStatus();
    expect(status?.runId).toBe(id);
    expect(status?.status).toBe('running');
    expect(status?.finishedAt).toBeNull();
    expect(status?.counters).toEqual({
      playlistsTotal: null,
      playlistsProcessed: 0,
      playlistsFailed: 0,
      tracksProcessed: 0,
      changesRecorded: 0,
    });
  });
});
