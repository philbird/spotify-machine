import express from 'express';
import { runFullSync } from '../../sync/full.js';
import { runPlaysPoll } from '../../sync/plays.js';
import { getRecentRuns } from '../../sync/runs.js';

export const syncRouter = express.Router();

let inflight: { kind: 'full' | 'plays' } | null = null;

syncRouter.post('/full', async (_req, res, next) => {
  if (inflight) return res.status(409).json({ error: `A ${inflight.kind} sync is already running` });
  inflight = { kind: 'full' };
  try {
    const result = await runFullSync();
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    inflight = null;
  }
});

syncRouter.post('/plays', async (_req, res, next) => {
  if (inflight) return res.status(409).json({ error: `A ${inflight.kind} sync is already running` });
  inflight = { kind: 'plays' };
  try {
    const result = await runPlaysPoll();
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    inflight = null;
  }
});

syncRouter.get('/runs', (_req, res) => {
  res.json(getRecentRuns(50));
});

syncRouter.get('/inflight', (_req, res) => {
  res.json({ inflight });
});
