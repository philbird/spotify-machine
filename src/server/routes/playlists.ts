import express from 'express';
import { db } from '../../db/index.js';

export const playlistsRouter = express.Router();

playlistsRouter.get('/', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT id, name, owner_name, track_count, is_liked_songs, last_synced_at
       FROM playlists ORDER BY is_liked_songs DESC, name COLLATE NOCASE`
    )
    .all();
  res.json(rows);
});

playlistsRouter.get('/:id/tracks', (req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.name, t.artist_names, t.album, t.duration_ms,
              pt.position, pt.added_at,
              COALESCE(pc.total_plays, 0) AS total_plays,
              pc.last_played_at
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       LEFT JOIN play_counts pc ON pc.track_id = t.id
       WHERE pt.playlist_id = ?
       ORDER BY pt.position`
    )
    .all(req.params.id);
  res.json(rows);
});
