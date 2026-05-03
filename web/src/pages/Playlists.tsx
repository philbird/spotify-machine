import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type PlaylistRow, type PlaylistTrackRow } from '../api';

export function Playlists() {
  const [rows, setRows] = useState<PlaylistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.playlists().then(setRows).catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.owner_name ?? '').toLowerCase().includes(q)
    );
  }, [rows, filter]);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!rows) return <p>Loading…</p>;
  if (rows.length === 0)
    return <p className="muted">No playlists yet — run a full sync first.</p>;

  return (
    <>
      <h2>Playlists</h2>
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Filter by name or owner…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 320 }}
        />
        <span className="muted" style={{ marginLeft: 12 }}>
          {filtered?.length ?? 0} of {rows.length}
        </span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th style={{ textAlign: 'right' }}>Tracks</th>
              <th>Last synced</th>
            </tr>
          </thead>
          <tbody>
            {filtered!.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/playlists/${encodeURIComponent(r.id)}`}>
                    {r.is_liked_songs ? '♥ ' : ''}
                    {r.name}
                  </Link>
                </td>
                <td className="muted">{r.owner_name ?? ''}</td>
                <td style={{ textAlign: 'right' }}>{r.track_count}</td>
                <td className="muted">
                  {r.last_synced_at ? new Date(r.last_synced_at).toLocaleString() : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function PlaylistDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const [tracks, setTracks] = useState<PlaylistTrackRow[] | null>(null);
  const [meta, setMeta] = useState<PlaylistRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTracks(null);
    setMeta(null);
    setError(null);
    Promise.all([api.playlists(), api.playlistTracks(id)])
      .then(([all, rows]) => {
        setMeta(all.find((p) => p.id === id) ?? null);
        setTracks(rows);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (!tracks) return <p>Loading…</p>;

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link to="/playlists">← All playlists</Link>
      </p>
      <h2 style={{ marginBottom: 4 }}>
        {meta?.is_liked_songs ? '♥ ' : ''}
        {meta?.name ?? id}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {meta?.owner_name ? `${meta.owner_name} · ` : ''}
        {tracks.length} track{tracks.length === 1 ? '' : 's'}
      </p>
      {tracks.length === 0 ? (
        <p className="muted">This playlist has no tracks (or it was unreadable during sync).</p>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 40, textAlign: 'right' }}>#</th>
                <th>Title</th>
                <th>Artist</th>
                <th>Album</th>
                <th style={{ textAlign: 'right' }}>Length</th>
                <th style={{ textAlign: 'right' }}>Plays</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((t) => (
                <tr key={`${t.position}-${t.id}`}>
                  <td className="muted" style={{ textAlign: 'right' }}>{t.position + 1}</td>
                  <td>{t.name}</td>
                  <td className="muted">{formatArtists(t.artist_names)}</td>
                  <td className="muted">{t.album ?? ''}</td>
                  <td className="muted" style={{ textAlign: 'right' }}>{formatDuration(t.duration_ms)}</td>
                  <td style={{ textAlign: 'right' }}>{t.total_plays}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function formatArtists(json: string): string {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.join(', ') : String(json);
  } catch {
    return json;
  }
}

function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
