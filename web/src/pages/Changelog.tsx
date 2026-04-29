import { useEffect, useState } from 'react';
import { api, type ChangelogRow } from '../api';

export function Changelog() {
  const [rows, setRows] = useState<ChangelogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.changelog(200).then(setRows).catch((e) => setError(String(e)));
  }, []);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!rows) return <p>Loading…</p>;
  if (rows.length === 0) return <p className="muted">No changes yet — run a sync first.</p>;

  return (
    <>
      <h2>Changelog</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Playlist</th>
              <th>Track</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.occurred_at).toLocaleString()}</td>
                <td><span className="event-pill">{r.event_type}</span></td>
                <td>{r.playlist_name ?? r.playlist_id ?? ''}</td>
                <td>
                  {r.track_name ? `${r.track_name}${r.track_artists ? ' — ' + JSON.parse(r.track_artists).join(', ') : ''}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
