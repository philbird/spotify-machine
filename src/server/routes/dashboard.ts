import express from 'express';
import { db } from '../../db/index.js';
import { getLastRunOfKind } from '../../sync/runs.js';

export const dashboardRouter = express.Router();

dashboardRouter.get('/', (_req, res) => {
  const counts = db()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM playlists WHERE is_liked_songs = 0) AS playlists,
        (SELECT COUNT(*) FROM tracks) AS tracks,
        (SELECT COUNT(*) FROM play_events) AS plays,
        (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = '__liked__') AS liked`
    )
    .get();

  res.json({
    counts,
    lastFullSync: getLastRunOfKind('full'),
    lastPlaysPoll: getLastRunOfKind('plays'),
  });
});
