import { useEffect, useState } from 'react';
import { api, type Settings as SettingsType } from '../api';

export function Settings() {
  const [s, setS] = useState<SettingsType | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setError(String(e)));
  }, []);

  async function save() {
    if (!s) return;
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(s);
      setS(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!s) return <p>Loading…</p>;

  return (
    <>
      <h2>Settings</h2>

      <div className="card">
        <strong>Run mode</strong>
        <p className="muted" style={{ marginTop: 4 }}>
          When the scheduler is off, the service only syncs when you click "Sync now" or run the CLI.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={s.schedulerEnabled}
            onChange={(e) => setS({ ...s, schedulerEnabled: e.target.checked })}
          />
          <span style={{ marginBottom: 0 }}>Enable scheduled syncs</span>
        </label>
      </div>

      <div className="card">
        <strong>Schedule (cron expressions)</strong>
        <p className="muted" style={{ marginTop: 4 }}>
          5-field cron, e.g. <code>0 */6 * * *</code> = every 6 hours. Plays poll should be frequent (Spotify only returns the last 50 plays).
        </p>
        <label>
          <span>Full sync</span>
          <input type="text" value={s.fullSyncCron} onChange={(e) => setS({ ...s, fullSyncCron: e.target.value })} />
        </label>
        <label>
          <span>Plays poll</span>
          <input type="text" value={s.playsPollCron} onChange={(e) => setS({ ...s, playsPollCron: e.target.value })} />
        </label>
      </div>

      <button onClick={save}>Save</button>
      {saved && <span className="muted" style={{ marginLeft: 12 }}>Saved.</span>}
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </>
  );
}
