import { getValidAccessToken } from '../src/spotify/auth.js';

const playlistId = process.argv[2] ?? '4zJlTDIQe2KOXOLSxmDgwn';

const variants: Array<{ label: string; qs: string }> = [
  { label: 'plain', qs: 'limit=5' },
  { label: 'market=from_token', qs: 'limit=5&market=from_token' },
  { label: 'additional_types=track,episode', qs: 'limit=5&additional_types=track%2Cepisode' },
  { label: 'market+additional_types', qs: 'limit=5&market=from_token&additional_types=track%2Cepisode' },
  {
    label: 'narrow fields',
    qs: 'limit=5&fields=' + encodeURIComponent('items(track(id,name,artists(name))),next'),
  },
];

const token = await getValidAccessToken();
console.log(`token: ${token.slice(0, 20)}…`);
console.log(`playlist: ${playlistId}\n`);

// First: check whether plain GET on the playlist itself works
const plRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(`GET /playlists/${playlistId} → ${plRes.status}`);
if (!plRes.ok) console.log(`  body: ${(await plRes.text()).slice(0, 200)}`);
else {
  const text = await plRes.text();
  const j = JSON.parse(text) as { name: string; tracks?: { total?: number; items?: unknown[] } };
  console.log(`  top-level keys: ${Object.keys(j).join(', ')}`);
  console.log(`  tracks keys: ${j.tracks ? Object.keys(j.tracks).join(', ') : 'tracks is missing'}`);
  console.log(`  tracks.total=${j.tracks?.total} tracks.items?=${Array.isArray(j.tracks?.items) ? j.tracks!.items!.length : 'no'}`);
}

// Probe each variant
for (const v of variants) {
  const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?${v.qs}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`[${v.label}] ${r.status} ${r.statusText}`);
  if (!r.ok) {
    console.log(`  body: ${(await r.text()).slice(0, 200)}`);
  } else {
    const j = (await r.json()) as { items: unknown[] };
    console.log(`  items: ${j.items?.length}`);
  }
}

// Dump the raw /playlists/{id} response to see the new shape
console.log('\n--- raw /playlists/{id} response ---');
const rawRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const raw = await rawRes.text();
console.log(raw.slice(0, 2000));
console.log('...');

// Workaround: /playlists/{id} with fields= can embed tracks inline
console.log('\n--- workaround: /playlists/{id} with fields=tracks(items(...)) ---');
const fields = encodeURIComponent('name,tracks(total,next,items(added_at,is_local,track(id,name,artists(name),album(name),duration_ms,uri,explicit,external_ids,is_local)))');
const wRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=${fields}`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(`status: ${wRes.status}`);
if (!wRes.ok) console.log(`body: ${(await wRes.text()).slice(0, 200)}`);
else {
  const j = (await wRes.json()) as { name: string; tracks?: { total?: number; next?: string | null; items?: unknown[] } };
  console.log(`name=${j.name}`);
  console.log(`tracks.total=${j.tracks?.total} tracks.next=${j.tracks?.next ?? 'null'}`);
  console.log(`tracks.items.length=${j.tracks?.items?.length}`);
  if (j.tracks?.items?.length) {
    console.log(`first item: ${JSON.stringify(j.tracks.items[0]).slice(0, 300)}`);
  }
}
