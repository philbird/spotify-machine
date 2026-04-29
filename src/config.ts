import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  spotify: {
    clientId: required('SPOTIFY_CLIENT_ID'),
    clientSecret: required('SPOTIFY_CLIENT_SECRET'),
    redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8787/api/auth/callback',
    scopes: [
      'playlist-read-private',
      'playlist-read-collaborative',
      'user-library-read',
      'user-read-recently-played',
      'user-read-playback-state',
    ].join(' '),
  },
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/spotify.db'),
  port: Number(process.env.PORT ?? 8787),
};
