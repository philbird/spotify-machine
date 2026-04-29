export type SpotifyArtist = { id: string; name: string };

export type SpotifyAlbum = { id: string; name: string };

export type SpotifyTrack = {
  id: string | null;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  explicit: boolean;
  popularity?: number;
  preview_url: string | null;
  uri: string;
  external_ids?: { isrc?: string };
  is_local?: boolean;
};

export type SpotifyPlaylist = {
  id: string;
  name: string;
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  snapshot_id: string;
  owner: { id: string; display_name: string | null };
  tracks: { total: number };
};

export type SpotifyPlaylistTrackItem = {
  added_at: string | null;
  added_by: { id: string | null } | null;
  is_local: boolean;
  track: SpotifyTrack | null;
};

export type SpotifySavedTrackItem = {
  added_at: string;
  track: SpotifyTrack;
};

export type SpotifyPlayHistoryItem = {
  track: SpotifyTrack;
  played_at: string;
  context: { type: string; uri: string } | null;
};

export type SpotifyUser = { id: string; display_name: string | null };
