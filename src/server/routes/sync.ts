import express from 'express';
import {
  getFullSyncStatus,
  isFullSyncRunning,
  startFullSyncJob,
  toFullSyncStatus,
} from '../../sync/fullSyncJob.js';
import { runPlaysPoll } from '../../sync/plays.js';
import { getRecentRuns, getRunById } from '../../sync/runs.js';

export const syncRouter = express.Router();

let playsInflight = false;

// Claims the run synchronously and responds 202 before any sync work starts
// (the job begins on the next event-loop turn). 409 carries the active runId.
syncRouter.post('/full', (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const result = startFullSyncJob({ force });
  if (!result.started) {
    return res.status(409).json({ error: 'A full sync is already running', runId: result.runId });
  }
  result.completion.catch((err) => {
    // The run row is already finalized as 'error'; this just keeps the
    // rejection from being unhandled and leaves a server-side trace.
    console.error('[sync] full sync failed:', err instanceof Error ? err.message : err);
  });
  res.status(202).json({ runId: result.runId });
});

syncRouter.post('/plays', async (_req, res, next) => {
  if (playsInflight) return res.status(409).json({ error: 'A plays poll is already running' });
  if (isFullSyncRunning()) return res.status(409).json({ error: 'A full sync is already running' });
  playsInflight = true;
  try {
    const result = await runPlaysPoll();
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    playsInflight = false;
  }
});

// Latest full-sync run in any state (running/ok/error/interrupted). When no
// full sync has ever been recorded — a fresh database — returns 200 with
// { run: null }; clients must treat that as "nothing to show", not an error.
syncRouter.get('/status', (_req, res) => {
  res.json({ run: getFullSyncStatus() });
});

// Exact-run lookup so a client can keep following the run a POST returned even
// after a newer run has started.
syncRouter.get('/runs/:runId', (req, res) => {
  const id = Number(req.params.runId);
  const row = Number.isInteger(id) ? getRunById(id) : null;
  if (!row || row.kind !== 'full') return res.status(404).json({ error: 'Run not found' });
  res.json({ run: toFullSyncStatus(row) });
});

syncRouter.get('/runs', (_req, res) => {
  res.json(getRecentRuns(50));
});

syncRouter.get('/inflight', (_req, res) => {
  const inflight = isFullSyncRunning() ? { kind: 'full' as const } : playsInflight ? { kind: 'plays' as const } : null;
  res.json({ inflight });
});
