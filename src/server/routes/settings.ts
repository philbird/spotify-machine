import express from 'express';
import cron from 'node-cron';
import { getSettings, updateSettings, type AppSettings } from '../../db/settings.js';
import { applySchedule } from '../../scheduler/index.js';

export const settingsRouter = express.Router();

settingsRouter.get('/', (_req, res) => {
  res.json(getSettings());
});

settingsRouter.put('/', (req, res) => {
  const body = req.body as Partial<AppSettings>;
  if (body.fullSyncCron !== undefined && !cron.validate(body.fullSyncCron)) {
    return res.status(400).json({ error: 'Invalid fullSyncCron' });
  }
  if (body.playsPollCron !== undefined && !cron.validate(body.playsPollCron)) {
    return res.status(400).json({ error: 'Invalid playsPollCron' });
  }
  const next = updateSettings(body);
  applySchedule();
  res.json(next);
});
