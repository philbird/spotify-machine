import { useEffect, useState } from 'react';
import { api, ApiError, type AuthStatus, type DashboardData, type FullSyncStatus } from '../api';

const POLL_INTERVAL_MS = 2000;

export function Dashboard() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncRun, setSyncRun] = useState<FullSyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const syncRunning = syncRun?.status === 'running';

  async function refresh() {
    const [a, d] = await Promise.all([api.authStatus(), api.dashboard()]);
    setAuth(a);
    setData(d);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    // Detect a full sync that is already running (started elsewhere or before
    // this page loaded) so its persisted progress shows without any click.
    api
      .syncStatus()
      .then(({ run }) => setSyncRun(run))
      .catch(() => {
        // status unavailable — the sync card just shows nothing extra
      });
  }, []);

  // Poll status while a run is in flight; stops on ok / error / interrupted
  // (syncRunning flips false) and cleans up on unmount.
  useEffect(() => {
    if (!syncRunning) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const { run } = await api.syncStatus();
        if (cancelled) return;
        setSyncRun(run);
        if (run && run.status !== 'running') {
          refresh().catch(() => {});
        }
      } catch {
        // transient poll/network failure — keep polling, keep last progress
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [syncRunning]);

  async function connect() {
    const { url } = await api.loginUrl();
    window.location.href = url;
  }

  async function disconnect() {
    await api.disconnect();
    await refresh();
  }

  async function startFullSync(force: boolean) {
    setError(null);
    setNotice(null);
    try {
      await api.syncFull(force);
      // 202 — the run is registered; fetch its persisted status to start polling.
      const { run } = await api.syncStatus();
      setSyncRun(run);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // A sync is already running (another tab, scheduler, CLI) — attach to it.
        setNotice('A full sync is already running — showing its progress.');
        try {
          const { run } = await api.syncStatus();
          setSyncRun(run);
        } catch {
          // keep the notice; next manual attempt can retry
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async function pollPlays() {
    setBusy('plays');
    setError(null);
    try {
      await api.syncPlays();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => startFullSync(false)} disabled={!auth?.connected || syncRunning || busy !== null}>
            {syncRunning ? 'Syncing…' : 'Full sync now'}
          </button>
          <button
            className="secondary"
            onClick={() => startFullSync(true)}
            disabled={!auth?.connected || syncRunning || busy !== null}
            title="Re-fetch tracks for every playlist, ignoring snapshot_id. Use this once after a Spotify API change."
          >
            Force re-sync
          </button>
          <button className="secondary" onClick={pollPlays} disabled={!auth?.connected || syncRunning || busy !== null}>
            {busy === 'plays' ? 'Polling…' : 'Poll plays now'}
          </button>
        </div>
        {syncRun && <SyncRunStatus run={syncRun} />}
        {notice && <p className="muted">{notice}</p>}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>
    </>
  );
}

function SyncRunStatus({ run }: { run: FullSyncStatus }) {
  const { counters } = run;
  const progressText =
    counters.playlistsTotal == null
      ? 'starting…'
      : `${counters.playlistsProcessed}/${counters.playlistsTotal} playlists` +
        (counters.playlistsFailed > 0 ? ` (${counters.playlistsFailed} failed)` : '') +
        `, ${counters.tracksProcessed} tracks, ${counters.changesRecorded} changes`;

  if (run.status === 'running') {
    return (
      <p className="muted" role="status">
        Full sync running (run {run.runId}): {progressText}
        {run.currentPlaylist ? ` — syncing “${run.currentPlaylist.name}”` : ''}
      </p>
    );
  }
  if (run.status === 'error') {
    return (
      <p style={{ color: 'var(--danger)' }} role="status">
        Full sync run {run.runId} failed{run.error ? `: ${run.error}` : ''} ({progressText})
      </p>
    );
  }
  if (run.status === 'interrupted') {
    return (
      <p style={{ color: 'var(--danger)' }} role="status">
        Full sync run {run.runId} was interrupted (server restarted mid-sync). Start a new sync to catch up.
      </p>
    );
  }
  return (
    <p className="muted" role="status">
      Last full sync run {run.runId} completed: {progressText}
    </p>
  );
}
