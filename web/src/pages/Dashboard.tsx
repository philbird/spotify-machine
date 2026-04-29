import { useEffect, useState } from 'react';
import { api, type AuthStatus, type DashboardData } from '../api';

export function Dashboard() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [a, d] = await Promise.all([api.authStatus(), api.dashboard()]);
    setAuth(a);
    setData(d);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);

  async function connect() {
    const { url } = await api.loginUrl();
    window.location.href = url;
  }

  async function disconnect() {
    await api.disconnect();
    await refresh();
  }

  async function syncNow(kind: 'full' | 'plays') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'full') await api.syncFull();
      else await api.syncPlays();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Dashboard</h2>

      <div className="card">
        <strong>Spotify connection</strong>
        <div style={{ marginTop: 8 }}>
          {auth?.connected ? (
            <>
              <span>Connected{auth.user?.displayName ? ` as ${auth.user.displayName}` : ''}</span>
              <button className="secondary" style={{ marginLeft: 12 }} onClick={disconnect}>Disconnect</button>
            </>
          ) : (
            <button onClick={connect}>Connect Spotify</button>
          )}
        </div>
      </div>

      <div className="row">
        <div className="card">
          <div className="metric">{data?.counts.playlists ?? '—'}</div>
          <div className="metric-label">Playlists</div>
        </div>
        <div className="card">
          <div className="metric">{data?.counts.liked ?? '—'}</div>
          <div className="metric-label">Liked songs</div>
        </div>
        <div className="card">
          <div className="metric">{data?.counts.tracks ?? '—'}</div>
          <div className="metric-label">Unique tracks</div>
        </div>
        <div className="card">
          <div className="metric">{data?.counts.plays ?? '—'}</div>
          <div className="metric-label">Plays observed</div>
        </div>
      </div>

      <div className="card">
        <strong>Sync</strong>
        <p className="muted" style={{ marginTop: 4 }}>
          Last full sync: {data?.lastFullSync?.finished_at ?? 'never'}<br />
          Last plays poll: {data?.lastPlaysPoll?.finished_at ?? 'never'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => syncNow('full')} disabled={!auth?.connected || busy !== null}>
            {busy === 'full' ? 'Syncing…' : 'Full sync now'}
          </button>
          <button className="secondary" onClick={() => syncNow('plays')} disabled={!auth?.connected || busy !== null}>
            {busy === 'plays' ? 'Polling…' : 'Poll plays now'}
          </button>
        </div>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>
    </>
  );
}
