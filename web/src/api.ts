async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
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
  syncFull: () => request<{ runId: number; stats: unknown }>('/api/sync/full', { method: 'POST' }),
  syncPlays: () => request<{ runId: number; stats: unknown }>('/api/sync/plays', { method: 'POST' }),
  inflight: () => request<{ inflight: { kind: string } | null }>('/api/sync/inflight'),
  changelog: (limit = 50) => request<ChangelogRow[]>(`/api/changelog?limit=${limit}`),
};
