// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../app/page';
import { dayRange, type LineupItem } from '../lib/lineup';
import { guideFor, mixedLineup, mixedPrograms } from './fixtures';

type Reply = { status: number; body: unknown } | 'network-error';

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** A stateful fake of the companion's /api/tunarr routes. */
function fakeCompanion(options: { schedule?: unknown; health?: Reply; programming?: Reply; lineupStatus?: number } = {}) {
  const startTime = dayRange(today()).from.getTime() - 60 * 60_000;
  const state = { lineup: mixedLineup() as LineupItem[] };
  const channels = [
    { id: 'chan-movies', name: 'Movie Night', number: 7, startTime, duration: 140 * 60_000, programCount: 6 },
    { id: 'chan-news', name: 'Newsroom', number: 3, startTime, duration: 140 * 60_000, programCount: 6 },
  ];
  const requests: Array<{ method: string; path: string; search: URLSearchParams; body?: unknown }> = [];
  const reply = (r: Reply) => (r === 'network-error' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status })));

  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://lineup.local');
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname, search: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!url.pathname.startsWith('/api/tunarr/')) throw new Error(`Unexpected request to ${url}`);
    if (url.pathname === '/api/tunarr/health') return reply(options.health ?? { status: 200, body: { status: 'connected', tunarrHost: 'tunarr:8000', channelCount: 2 } });
    if (url.pathname === '/api/tunarr/channels') return reply({ status: 200, body: channels });
    const match = /^\/api\/tunarr\/channels\/([^/]+)\/(programming|lineup)$/.exec(url.pathname);
    if (match?.[2] === 'programming' && method === 'POST') {
      state.lineup = (JSON.parse(String(init!.body)) as { lineup: LineupItem[] }).lineup;
      return reply({ status: 200, body: { lineup: state.lineup, programs: mixedPrograms() } });
    }
    if (match?.[2] === 'programming') {
      return reply(options.programming ?? { status: 200, body: { lineup: state.lineup, programs: mixedPrograms(), totalPrograms: 6, schedule: options.schedule } });
    }
    if (match?.[2] === 'lineup') {
      if (options.lineupStatus) return reply({ status: options.lineupStatus, body: { error: { code: 'tunarr_error', message: 'Guide failed' } } });
      const from = new Date(url.searchParams.get('from')!).getTime();
      const to = new Date(url.searchParams.get('to')!).getTime();
      return reply({ status: 200, body: { id: match[1], programs: guideFor(state.lineup, startTime, from, to) } });
    }
    return reply({ status: 404, body: { error: { code: 'route_not_allowed', message: 'nope' } } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, state, fetchMock };
}

const count = (requests: ReturnType<typeof fakeCompanion>['requests'], method: string, path: string) => requests.filter((r) => r.method === method && r.path === path).length;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('live mode', () => {
  it('loads real channels, the first channel’s programming and Tunarr’s guide for today', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    expect(await screen.findByText('Movie Night')).toBeTruthy();
    expect(screen.getByText('Newsroom')).toBeTruthy();
    expect(screen.getByText('Tunarr connected')).toBeTruthy();
    // Channels are sorted by number, so Newsroom (3) loads first.
    await waitFor(() => expect(requests.some((r) => r.path === '/api/tunarr/channels/chan-news/programming')).toBe(true));
    await screen.findAllByText('Alpha Movie');
    const lineupCall = await waitFor(() => {
      const call = requests.find((r) => r.path === '/api/tunarr/channels/chan-news/lineup');
      expect(call).toBeTruthy();
      return call!;
    });
    const { from, to } = dayRange(today());
    expect(lineupCall.search.get('from')).toBe(from.toISOString());
    expect(lineupCall.search.get('to')).toBe(to.toISOString());
    // Every request stays on this app's origin.
    expect(requests.every((r) => r.path.startsWith('/api/tunarr/'))).toBe(true);
    expect(screen.queryByText('Studio Selects')).toBeNull();
  });

  it('requests the matching date range when navigating days', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    const next = new Date(`${today()}T12:00:00`);
    next.setDate(next.getDate() + 1);
    const { from, to } = dayRange(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`);
    await waitFor(() => expect(requests.some((r) => r.path.endsWith('/lineup') && r.search.get('from') === from.toISOString() && r.search.get('to') === to.toISOString())).toBe(true));
  });

  it('saves a reordered lineup, preserving every item, then re-fetches programming and the guide', async () => {
    const { requests, state } = fakeCompanion();
    const original = mixedLineup();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    await waitFor(() => expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/lineup')).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    expect(await screen.findByText(/Showing unsaved changes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));

    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.body).toEqual({ type: 'manual', lineup: JSON.parse(JSON.stringify([original[1], original[0], ...original.slice(2)])), append: false });
    expect(state.lineup[0].type).toBe('flex');

    await waitFor(() => expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/programming')).toBe(2));
    await waitFor(() => expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/lineup')).toBe(2));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    expect(screen.queryByText(/Showing unsaved changes/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Lineup saved to Tunarr');
  });

  it('undo restores the loaded lineup', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
  });

  it('warns before saving over a generated schedule', async () => {
    const { requests } = fakeCompanion({ schedule: { type: 'time', slots: [] } });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    expect(screen.getByText('Generated schedule')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Save over a generated schedule?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(0);
    expect(screen.getByRole('button', { name: 'Save lineup' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save manual lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
  });

  it('keeps changes and reports the error when a save fails', async () => {
    const { fetchMock } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    const passthrough = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => (init?.method === 'POST'
      ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'tunarr_rejected', message: 'Number must be greater than 0' } }), { status: 400 }))
      : passthrough(input, init)));
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByText('Not saved: Number must be greater than 0')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save lineup' })).toBeTruthy();
  });

  it('asks before discarding unsaved changes when switching channels', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByText('Movie Night'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests.some((r) => r.path === '/api/tunarr/channels/chan-movies/programming')).toBe(false);
  });
});

describe('no silent fallback to demo mode', () => {
  it('shows the unreachable host and waits for an explicit demo choice', async () => {
    fakeCompanion({ health: { status: 502, body: { status: 'unreachable', tunarrHost: '192.168.1.50:8000', error: { code: 'tunarr_unreachable', message: 'Could not reach Tunarr at 192.168.1.50:8000 (ECONNREFUSED).' } } } });
    render(<Home />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Can’t reach Tunarr')).toBeTruthy();
    expect(within(dialog).getByText('Could not reach Tunarr at 192.168.1.50:8000 (ECONNREFUSED).')).toBeTruthy();
    expect(within(dialog).getByText('192.168.1.50:8000')).toBeTruthy();
    expect(screen.getByText('Tunarr unreachable')).toBeTruthy();
    expect(screen.queryByText('Studio Selects')).toBeNull();
    expect(screen.queryByText('Demo mode')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use demo data' }));
    expect(await screen.findByText('Studio Selects')).toBeTruthy();
    expect(screen.getByText('Demo mode')).toBeTruthy();
    expect(screen.getByText('DEMO CHANNELS')).toBeTruthy();
  });

  it('explains how to configure TUNARR_URL when it is missing', async () => {
    fakeCompanion({ health: { status: 503, body: { status: 'not_configured', error: { code: 'not_configured', message: 'TUNARR_URL is not set on the Lineup server.' } } } });
    render(<Home />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Tunarr isn’t configured')).toBeTruthy();
    expect(within(dialog).getByText('TUNARR_URL=http://tunarr:8000')).toBeTruthy();
    expect(screen.queryByText('Studio Selects')).toBeNull();
  });

  it('treats a missing companion (hosted preview) as unavailable, not demo', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<!doctype html><p>Not found</p>', { status: 404 }))));
    render(<Home />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Live mode unavailable')).toBeTruthy();
    expect(screen.queryByText('Studio Selects')).toBeNull();
  });

  it('stays live with an error when programming fails to load', async () => {
    fakeCompanion({ programming: { status: 504, body: { error: { code: 'tunarr_timeout', message: 'Tunarr at tunarr:8000 did not respond within 10 seconds.', tunarrHost: 'tunarr:8000' } } } });
    render(<Home />);
    expect(await screen.findByText('Couldn’t load this channel')).toBeTruthy();
    expect(screen.getByText('Tunarr at tunarr:8000 did not respond within 10 seconds.')).toBeTruthy();
    expect(screen.getByText('Tunarr unreachable')).toBeTruthy();
    expect(screen.getByText('Movie Night')).toBeTruthy();
    expect(screen.queryByText('Studio Selects')).toBeNull();
    expect(screen.queryByText('Demo mode')).toBeNull();
  });

  it('falls back to a lineup projection, labeled, when the guide fails', async () => {
    fakeCompanion({ lineupStatus: 502 });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    expect(await screen.findByText(/guide for this date did not load \(Guide failed\)/)).toBeTruthy();
    expect(screen.queryByText('Demo mode')).toBeNull();
  });
});
