import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
};

type SpotifyTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

const REFRESH_SAFETY_MS = 60_000;

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    scope: config.spotify.scopes,
    redirect_uri: config.spotify.redirectUri,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export function newState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.spotify.redirectUri,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64'),
    },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as SpotifyTokenResponse;
  if (!json.refresh_token) throw new Error('No refresh_token in token response');
  storeTokens(json.access_token, json.refresh_token, json.expires_in, json.scope);
}

function storeTokens(accessToken: string, refreshToken: string, expiresInSec: number, scope?: string): void {
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  db()
    .prepare(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES (1, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         updated_at = excluded.updated_at`
    )
    .run(accessToken, refreshToken, expiresAt, scope ?? null);
}

export function getStoredTokens(): TokenRow | null {
  return (db().prepare('SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE id = 1').get() as TokenRow | undefined) ?? null;
}

export function clearTokens(): void {
  db().prepare('DELETE FROM oauth_tokens WHERE id = 1').run();
}

export async function getValidAccessToken(): Promise<string> {
  const row = getStoredTokens();
  if (!row) throw new Error('Not authenticated with Spotify. Connect via the UI first.');

  const expiresAtMs = new Date(row.expires_at).getTime();
  if (expiresAtMs - Date.now() > REFRESH_SAFETY_MS) return row.access_token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64'),
    },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as SpotifyTokenResponse;
  storeTokens(json.access_token, json.refresh_token ?? row.refresh_token, json.expires_in, json.scope);
  return json.access_token;
}
