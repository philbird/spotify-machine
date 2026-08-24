export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — keep raw text
    }
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : text || `${res.status}`;
    throw new ApiError(res.status, body, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type AuthStatus = { connected: boolean; user: { id: string; displayName: string | null } | null };
export type Settings = { schedulerEnabled: boolean; fullSyncCron: string; playsPollCron: string };
export type DashboardData = {
  counts: { playlists: number; tracks: number; plays: number; liked: number };
  lastFullSync: SyncRun | null;
  lastPlaysPoll: SyncRun | null;
};
export type SyncRun = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  stats: string | null;
};
export type SyncCounters = {
  playlistsTotal: number | null;
  playlistsProcessed: number;
  playlistsFailed: number;
  tracksProcessed: number;
  changesRecorded: number;
};
export type FullSyncStatus = {
  runId: number;
  status: 'running' | 'ok' | 'error' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  currentPlaylist: { id: string; name: string } | null;
  counters: SyncCounters;
  error: string | null;
};
export type PlaylistRow = {
  id: string;
  name: string;
  owner_name: string | null;
  track_count: number;
  is_liked_songs: 0 | 1;
  last_synced_at: string | null;
};
export type PlaylistTrackRow = {
  id: string;
  name: string;
  artist_names: string;
  album: string | null;
  duration_ms: number | null;
  position: number;
  added_at: string | null;
  total_plays: number;
  last_played_at: string | null;
};
export type ChangelogRow = {
  id: number;
  occurred_at: string;
  event_type: string;
  playlist_id: string | null;
  track_id: string | null;
  details: string | null;
  playlist_name: string | null;
  track_name: string | null;
  track_artists: string | null;
};

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  loginUrl: () => request<{ url: string }>('/api/auth/login'),
  disconnect: () => request<{ ok: boolean }>('/api/auth/disconnect', { method: 'POST' }),
  dashboard: () => request<DashboardData>('/api/dashboard'),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  syncFull: (force = false) =>
    request<{ runId: number }>(`/api/sync/full${force ? '?force=1' : ''}`, { method: 'POST' }),
  syncPlays: () => request<{ runId: number; stats: unknown }>('/api/sync/plays', { method: 'POST' }),
  // { run: null } means no full sync has ever been recorded (fresh database).
  syncStatus: () => request<{ run: FullSyncStatus | null }>('/api/sync/status'),
  inflight: () => request<{ inflight: { kind: string } | null }>('/api/sync/inflight'),
  changelog: (limit = 50) => request<ChangelogRow[]>(`/api/changelog?limit=${limit}`),
  playlists: () => request<PlaylistRow[]>('/api/playlists'),
  playlistTracks: (id: string) =>
    request<PlaylistTrackRow[]>(`/api/playlists/${encodeURIComponent(id)}/tracks`),
};
