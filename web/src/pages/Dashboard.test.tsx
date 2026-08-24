// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullSyncStatus } from '../api';
import { Dashboard } from './Dashboard';

function counters(overrides: Partial<FullSyncStatus['counters']> = {}): FullSyncStatus['counters'] {
  return {
    playlistsTotal: 3,
    playlistsProcessed: 1,
    playlistsFailed: 0,
    tracksProcessed: 10,
    changesRecorded: 2,
    ...overrides,
  };
}

function runningRun(overrides: Partial<FullSyncStatus> = {}): FullSyncStatus {
  return {
    runId: 7,
    status: 'running',
    startedAt: '2026-08-24T00:00:00.000Z',
    finishedAt: null,
    currentPlaylist: { id: 'pl2', name: 'Road Trip' },
    counters: counters(),
    error: null,
    ...overrides,
  };
}

function okRun(): FullSyncStatus {
  return runningRun({
    status: 'ok',
    finishedAt: '2026-08-24T00:01:00.000Z',
    currentPlaylist: null,
    counters: counters({ playlistsProcessed: 3 }),
  });
}

// Minimal Response stand-in covering everything web/src/api.ts touches.
function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Queue of /api/sync/status payloads; the last entry repeats once drained.
let statusQueue: (FullSyncStatus | null)[] = [null];
let postFullResponse: () => ReturnType<typeof jsonRes> = () => jsonRes({ runId: 7 }, 202);
let fetchMock: ReturnType<typeof vi.fn>;

function statusCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/sync/status')).length;
}

beforeEach(() => {
  statusQueue = [null];
  postFullResponse = () => jsonRes({ runId: 7 }, 202);
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.includes('/api/auth/status')) return jsonRes({ connected: true, user: null });
    if (url.includes('/api/dashboard'))
      return jsonRes({ counts: { playlists: 3, tracks: 10, plays: 0, liked: 5 }, lastFullSync: null, lastPlaysPoll: null });
    if (url.includes('/api/sync/full') && init?.method === 'POST') return postFullResponse();
    if (url.includes('/api/sync/status')) {
      const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      return jsonRes({ run: next ?? null });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderDashboard() {
  const utils = render(<Dashboard />);
  await act(async () => {}); // flush initial-load promises
  return utils;
}

async function tickPoll(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  }
}

describe('Dashboard sync polling', () => {
  it('detects an already-running job on load, shows persisted progress, and polls', async () => {
    statusQueue = [runningRun(), runningRun({ counters: counters({ playlistsProcessed: 2 }) })];
    await renderDashboard();

    // Progress from the persisted run is shown without any click.
    expect(screen.getByRole('status').textContent).toContain('Full sync running (run 7)');
    expect(screen.getByRole('status').textContent).toContain('1/3 playlists');
    expect(screen.getByRole('status').textContent).toContain('Road Trip');
    expect(statusCalls()).toBe(1);

    await tickPoll();
    expect(statusCalls()).toBe(2);
    expect(screen.getByRole('status').textContent).toContain('2/3 playlists');
  });

  it('stops polling once the run reaches a terminal status, without a refresh', async () => {
    statusQueue = [runningRun(), runningRun(), okRun()];
    await renderDashboard();

    await tickPoll(2); // second poll returns ok
    expect(screen.getByRole('status').textContent).toContain('completed');
    const callsAtCompletion = statusCalls();

    await tickPoll(3); // interval is gone — no further status requests
    expect(statusCalls()).toBe(callsAtCompletion);
  });

  it('stops polling when the run ends as error', async () => {
    statusQueue = [runningRun(), runningRun({ status: 'error', finishedAt: '2026-08-24T00:01:00.000Z', currentPlaylist: null, error: 'boom' })];
    await renderDashboard();

    await tickPoll();
    expect(screen.getByRole('status').textContent).toContain('failed');
    expect(screen.getByRole('status').textContent).toContain('boom');
    const calls = statusCalls();
    await tickPoll(2);
    expect(statusCalls()).toBe(calls);
  });

  it('cleans up polling on unmount', async () => {
    statusQueue = [runningRun()];
    const { unmount } = await renderDashboard();

    await tickPoll(2);
    const callsBeforeUnmount = statusCalls();
    expect(callsBeforeUnmount).toBeGreaterThan(1);

    unmount();
    await tickPoll(3);
    expect(statusCalls()).toBe(callsBeforeUnmount);
  });

  it('starts polling after a 202 from "Full sync now"', async () => {
    statusQueue = [null]; // idle on load
    await renderDashboard();
    expect(screen.queryByRole('status')).toBeNull();

    statusQueue = [runningRun({ currentPlaylist: null, counters: counters({ playlistsTotal: null, playlistsProcessed: 0, tracksProcessed: 0, changesRecorded: 0 }) }), runningRun()];
    await act(async () => {
      fireEvent.click(screen.getByText('Full sync now'));
    });
    expect(screen.getByRole('status').textContent).toContain('starting…');

    await tickPoll();
    expect(screen.getByRole('status').textContent).toContain('1/3 playlists');
  });

  it('handles a 409 start by attaching to the active run', async () => {
    statusQueue = [null];
    await renderDashboard();

    postFullResponse = () => jsonRes({ error: 'A full sync is already running', runId: 7 }, 409);
    statusQueue = [runningRun()];
    await act(async () => {
      fireEvent.click(screen.getByText('Full sync now'));
    });

    expect(screen.getByText(/already running — showing its progress/i)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Full sync running (run 7)');

    await tickPoll();
    expect(statusCalls()).toBeGreaterThanOrEqual(3);
  });

  it('keeps polling through transient status fetch failures', async () => {
    statusQueue = [runningRun()];
    await renderDashboard();

    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('network down');
    });
    await tickPoll(); // failed poll — progress unchanged, no crash
    expect(screen.getByRole('status').textContent).toContain('1/3 playlists');

    fetchMock.mockImplementation(original);
    statusQueue = [runningRun({ counters: counters({ playlistsProcessed: 2 }) })];
    await tickPoll();
    expect(screen.getByRole('status').textContent).toContain('2/3 playlists');
  });
});
