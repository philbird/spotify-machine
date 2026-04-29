import express from 'express';
import { db } from '../../db/index.js';

export const changelogRouter = express.Router();

changelogRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const playlistId = req.query.playlist_id as string | undefined;

  const rows = playlistId
    ? db()
        .prepare(
          `SELECT c.*, p.name AS playlist_name, t.name AS track_name, t.artist_names AS track_artists
           FROM changelog c
           LEFT JOIN playlists p ON p.id = c.playlist_id
           LEFT JOIN tracks t ON t.id = c.track_id
           WHERE c.playlist_id = ?
           ORDER BY c.occurred_at DESC LIMIT ?`
        )
        .all(playlistId, limit)
    : db()
        .prepare(
          `SELECT c.*, p.name AS playlist_name, t.name AS track_name, t.artist_names AS track_artists
           FROM changelog c
           LEFT JOIN playlists p ON p.id = c.playlist_id
           LEFT JOIN tracks t ON t.id = c.track_id
           ORDER BY c.occurred_at DESC LIMIT ?`
        )
        .all(limit);

  res.json(rows);
});
