import { paginate, spotifyFetch } from './client.js';
import type {
  SpotifyPlayHistoryItem,
  SpotifyPlaylist,
  SpotifyPlaylistTrackItem,
  SpotifySavedTrackItem,
  SpotifyUser,
} from './types.js';

export async function getCurrentUser(): Promise<SpotifyUser> {
  return spotifyFetch<SpotifyUser>('/me');
}

export async function* getAllPlaylists(): AsyncGenerator<SpotifyPlaylist, void, void> {
  yield* paginate<SpotifyPlaylist>('/me/playlists?limit=50');
}

export async function* getPlaylistTracks(playlistId: string): AsyncGenerator<SpotifyPlaylistTrackItem, void, void> {
  yield* paginate<SpotifyPlaylistTrackItem>(`/playlists/${playlistId}/tracks?limit=100`);
}

export async function* getLikedTracks(): AsyncGenerator<SpotifySavedTrackItem, void, void> {
  yield* paginate<SpotifySavedTrackItem>('/me/tracks?limit=50');
}

export async function getRecentlyPlayed(afterUnixMs?: number): Promise<SpotifyPlayHistoryItem[]> {
  const qs = new URLSearchParams({ limit: '50' });
  if (afterUnixMs) qs.set('after', String(afterUnixMs));
  const res = await spotifyFetch<{ items: SpotifyPlayHistoryItem[] }>(`/me/player/recently-played?${qs.toString()}`);
  return res.items;
}
