import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-machine-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const { db, closeDb } = await import('../src/db/index.js');
const job = await import('../src/sync/fullSyncJob.js');
const runs = await import('../src/sync/runs.js');
const { createServer } = await import('../src/server/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => {
  job.setFullSyncExecutorForTests(null);
  db().prepare('DELETE FROM changelog').run();
  db().prepare('DELETE FROM sync_runs').run();
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

// Executor that blocks until the returned gate resolves, then finalizes ok.
function gatedExecutor() {
  const gate = deferred();
  job.setFullSyncExecutorForTests(async (runId) => {
    await gate.promise;
    runs.finishRun(runId, 'ok', okStats());
    return okStats();
  });
  return gate;
}

async function getStatus(): Promise<{ run: import('../src/sync/fullSyncJob.js').FullSyncStatus | null }> {
  const res = await fetch(`${base}/api/sync/status`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('POST /api/sync/full', () => {
  it('responds 202 with the runId while the sync work is still pending', async () => {
    const gate = gatedExecutor();

    const res = await fetch(`${base}/api/sync/full`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: number };
    expect(body.runId).toBeGreaterThan(0);

    // The response arrived while the work is still gated: status shows running.
    const during = await getStatus();
    expect(during.run?.runId).toBe(body.runId);
    expect(during.run?.status).toBe('running');
    expect(during.run?.finishedAt).toBeNull();

    gate.resolve();
    await vi_waitFor(async () => (await getStatus()).run?.status === 'ok');
  });

  it('rejects a simultaneous second POST with 409 and the active runId', async () => {
    const gate = gatedExecutor();

    const [res1, res2] = await Promise.all([
      fetch(`${base}/api/sync/full`, { method: 'POST' }),
      fetch(`${base}/api/sync/full`, { method: 'POST' }),
    ]);
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([202, 409]);

    const accepted = (await (res1.status === 202 ? res1 : res2).json()) as { runId: number };
    const rejected = (await (res1.status === 409 ? res1 : res2).json()) as { error: string; runId: number };
    expect(rejected.runId).toBe(accepted.runId);
    expect(rejected.error).toMatch(/already running/i);

    gate.resolve();
    await vi_waitFor(async () => (await getStatus()).run?.status === 'ok');
  });
});

describe('GET /api/sync/status', () => {
  it('returns { run: null } when no full sync has ever been recorded', async () => {
    const body = await getStatus();
    expect(body).toEqual({ run: null });
  });

  it('returns the latest run with runId, status, timestamps, counters, and error', async () => {
    job.setFullSyncExecutorForTests(async () => {
      throw new Error('spotify exploded: token=abc123');
    });
    const res = await fetch(`${base}/api/sync/full`, { method: 'POST' });
    const { runId } = (await res.json()) as { runId: number };

    await vi_waitFor(async () => (await getStatus()).run?.status === 'error');
    const { run } = await getStatus();
    expect(run).toMatchObject({ runId, status: 'error' });
    expect(run?.startedAt).toBeTruthy();
    expect(run?.finishedAt).toBeTruthy();
    expect(run?.currentPlaylist).toBeNull();
    expect(run?.counters).toEqual({
      playlistsTotal: null,
      playlistsProcessed: 0,
      playlistsFailed: 0,
      tracksProcessed: 0,
      changesRecorded: 0,
    });
    expect(run?.error).toBeTruthy();
  });
});

describe('GET /api/sync/runs/:runId', () => {
  it('returns the exact run even after a newer run exists, and 404s on unknown ids', async () => {
    job.setFullSyncExecutorForTests(async (runId) => {
      runs.finishRun(runId, 'ok', okStats());
      return okStats();
    });
    const first = (await (await fetch(`${base}/api/sync/full`, { method: 'POST' })).json()) as { runId: number };
    await vi_waitFor(async () => (await getStatus()).run?.status === 'ok');
    const second = (await (await fetch(`${base}/api/sync/full`, { method: 'POST' })).json()) as { runId: number };
    await vi_waitFor(async () => (await getStatus()).run?.runId === second.runId);

    const res = await fetch(`${base}/api/sync/runs/${first.runId}`);
    expect(res.status).toBe(200);
    const { run } = (await res.json()) as { run: { runId: number; status: string } };
    expect(run.runId).toBe(first.runId);
    expect(run.status).toBe('ok');

    expect((await fetch(`${base}/api/sync/runs/999999`)).status).toBe(404);
    expect((await fetch(`${base}/api/sync/runs/not-a-number`)).status).toBe(404);
  });
});

// Small polling helper (avoids importing vitest's waitFor semantics).
async function vi_waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met within timeout');
}
