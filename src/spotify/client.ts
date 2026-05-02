import { getValidAccessToken } from './auth.js';

const API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  status: number;
  body: string;
  url: string;
  constructor(status: number, body: string, url: string) {
    super(`Spotify API ${status} at ${url}: ${body}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  let attempt = 0;
  while (true) {
    const token = await getValidAccessToken();
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1');
      await sleep(Math.min(retryAfter, 30) * 1000);
      attempt++;
      if (attempt > 5) throw new SpotifyError(429, 'rate limited (gave up after 5 retries)', url);
      continue;
    }

    if (!res.ok) {
      throw new SpotifyError(res.status, await res.text(), url);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Page<T> = { items: T[]; next: string | null };

export async function* paginate<T>(firstPath: string): AsyncGenerator<T, void, void> {
  let url: string | null = firstPath;
  while (url) {
    const page: Page<T> = await spotifyFetch<Page<T>>(url);
    for (const item of page.items) yield item;
    url = page.next;
  }
}
