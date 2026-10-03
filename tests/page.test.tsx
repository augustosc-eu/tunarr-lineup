// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../app/page';
import { draftStore } from '../lib/draftStore';
import { dayRange, type LineupItem } from '../lib/lineup';
import { programmingVersion } from '../server/lineupVersion';
import { guideFor, mixedLineup, mixedPrograms } from './fixtures';

type Reply = { status: number; body: unknown } | 'network-error';

const FILLER_ID = 'f0000000-0000-4000-8000-0000000000f1';
const CUSTOM_ID = 'c0000000-0000-4000-8000-0000000000c1';
const LIBRARY_MOVIE = { uuid: 'a1b2c3d4-0000-4000-8000-0000000000d1', type: 'movie', title: 'Zulu Movie', year: 1999, duration: 90 * 60_000 };

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** A stateful fake of the companion's /api/tunarr routes. */
function fakeCompanion(options: { schedule?: { type: string; slots: unknown[]; [key: string]: unknown }; health?: Reply; programming?: Reply; lineupStatus?: number } = {}) {
  const startTime = dayRange(today()).from.getTime() - 60 * 60_000;
  const state = {
    lineup: mixedLineup() as LineupItem[],
    previewedSlots: undefined as unknown,
    fillerLists: [{ id: FILLER_ID, name: 'Station Ads', contentCount: 3, synced: false }] as Array<{ id: string; name: string; contentCount?: number; synced: boolean }>,
    settings: { id: 'chan-news', name: 'Newsroom', number: 3, fillerCollections: [] as unknown[], fillerRepeatCooldown: 30000, disableFillerOverlay: false, guideMinimumDuration: 30000, guideFlexTitle: '', groupTitle: 'tunarr', startTime },
  };
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
    // Library and lists (see server/content.ts for the real routes).
    if (url.pathname === '/api/tunarr/media-sources') return reply({ status: 200, body: [{ id: 'src-1', name: 'Plex', type: 'plex', libraries: [{ id: 'lib-movies', name: 'Movies', mediaType: 'movies' }] }] });
    if (url.pathname === '/api/tunarr/library/search') return reply({ status: 200, body: { results: [LIBRARY_MOVIE], page: 0, totalPages: 1, totalHits: 1 } });
    if (url.pathname === '/api/tunarr/custom-shows') return reply({ status: 200, body: [{ id: CUSTOM_ID, name: 'Marathon', contentCount: 2, synced: false }] });
    if (url.pathname === '/api/tunarr/smart-collections') return reply({ status: 200, body: [] });
    if (url.pathname === '/api/tunarr/filler-lists' && method === 'GET') return reply({ status: 200, body: state.fillerLists });
    if (url.pathname === '/api/tunarr/filler-lists' && method === 'POST') {
      const created = JSON.parse(String(init!.body)) as { name: string; programs: unknown[] };
      state.fillerLists.push({ id: 'f0000000-0000-4000-8000-0000000000f9', name: created.name, contentCount: created.programs.length, synced: false });
      return reply({ status: 201, body: { id: 'f0000000-0000-4000-8000-0000000000f9' } });
    }
    if (url.pathname === '/api/tunarr/channels/chan-news/settings') {
      if (method === 'PUT') Object.assign(state.settings, JSON.parse(String(init!.body)));
      return reply({ status: 200, body: state.settings });
    }
    const match = /^\/api\/tunarr\/channels\/([^/]+)\/(programming|lineup|schedule|schedule-preview)$/.exec(url.pathname);
    if (match?.[2] === 'schedule') return reply({ status: 200, body: { schedule: options.schedule } });
    if (match?.[2] === 'schedule-preview') {
      const { slots } = JSON.parse(String(init!.body)) as { slots: unknown[] };
      state.previewedSlots = slots;
      return reply({ status: 200, body: { startTime, lineup: [...state.lineup].reverse(), programs: mixedPrograms(), seed: [11, 22], discardCount: 3 } });
    }
    if (match?.[2] === 'programming' && method === 'POST') {
      // Like the companion: refuse saves based on an outdated version.
      const ifMatch = String((init?.headers as Record<string, string>)['if-match'] ?? '').replaceAll('"', '');
      if (ifMatch !== programmingVersion(state.lineup, options.schedule)) {
        return reply({ status: 412, body: { error: { code: 'lineup_changed', message: 'This channel changed in Tunarr since it was loaded. Nothing was saved.' } } });
      }
      const saved = JSON.parse(String(init!.body)) as { type: string; lineup?: LineupItem[] };
      if (saved.type === 'manual') state.lineup = saved.lineup!;
      else state.lineup = [...state.lineup].reverse();
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

beforeEach(async () => {
  vi.unstubAllGlobals();
  // Drafts outlive a render on purpose; tests must not see each other's.
  const store = draftStore();
  for (const draft of await store.list()) await store.delete(draft.channelId);
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
    expect(screen.getAllByRole('button', { name: 'Undo' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Moved “Alpha Movie” later')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));

    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.body).toEqual({ type: 'manual', lineup: JSON.parse(JSON.stringify([original[1], original[0], ...original.slice(2)])), append: false });
    expect(state.lineup[0].type).toBe('flex');

    // Initial load and the re-read after saving (the version check happens in the companion).
    await waitFor(() => expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/programming')).toBe(2));
    await waitFor(() => expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/lineup')).toBe(2));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    expect(screen.queryByText(/Showing unsaved changes/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Lineup saved to Tunarr');
  });

  it('undoes and redoes step by step, and reverts everything', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    expect(screen.getByText('EDIT LIST (2)')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    expect(screen.getByText('EDIT LIST (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save lineup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByText('EDIT LIST (2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revert all' }));
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

  it('keeps unsaved changes and the edit list per channel when switching channels', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByText('Movie Night'));
    await waitFor(() => expect(document.querySelector('.channel.active')?.textContent).toContain('Movie Night'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('· unsaved')).toBeTruthy();
    await screen.findByRole('button', { name: 'Saved' });
    fireEvent.click(screen.getByText('Newsroom'));
    expect(await screen.findByRole('button', { name: 'Save lineup' })).toBeTruthy();
    expect(screen.getByText('Moved “Alpha Movie” later')).toBeTruthy();
  });

  it('restores unsaved changes and undo history after a reload', async () => {
    fakeCompanion();
    const first = render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    await waitFor(async () => expect((await draftStore().get('chan-news'))?.past).toHaveLength(2));
    first.unmount();
    render(<Home />);
    expect(await screen.findByText(/Restored your unsaved changes \(2 edits\)/)).toBeTruthy();
    expect(screen.getByText('EDIT LIST (2)')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    expect(screen.getByText('EDIT LIST (1)')).toBeTruthy();
  });

  it('keeps the edit list after saving, so a save can be undone', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    expect(screen.getByText('Moved “Alpha Movie” later')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(2));
    const posts = requests.filter((r) => r.method === 'POST');
    expect((posts[1].body as { lineup: LineupItem[] }).lineup.map((item) => item.id ?? item.type)).toEqual(mixedLineup().map((item) => item.id ?? item.type));
  });

  it('drops a stored draft when Tunarr’s lineup changed since it was made', async () => {
    const { state } = fakeCompanion();
    const first = render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    await waitFor(async () => expect((await draftStore().get('chan-news'))?.dirty).toBe(true));
    first.unmount();
    state.lineup = [...state.lineup].reverse();
    render(<Home />);
    expect(await screen.findByText(/changed in Tunarr since you last edited it here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy();
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

const lineupOrder = (requests: ReturnType<typeof fakeCompanion>['requests']) =>
  (requests.find((r) => r.method === 'POST')!.body as { lineup: LineupItem[] }).lineup.map((item) => item.id ?? item.type);

describe('programming desk tools', () => {
  it('refuses to overwrite changes made elsewhere since loading', async () => {
    const { requests, state } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    // Someone edits the channel in Tunarr's own UI meanwhile.
    state.lineup = [...state.lineup].reverse();
    const elsewhere = state.lineup;
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('This channel changed in Tunarr')).toBeTruthy();
    // The companion refused the write, so the edit made elsewhere survives.
    expect(state.lineup).toBe(elsewhere);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep my edits' }));
    expect(screen.getByRole('button', { name: 'Save lineup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reload from Tunarr' }));
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    expect(state.lineup).toBe(elsewhere);
    expect(count(requests, 'GET', '/api/tunarr/channels/chan-news/programming')).toBe(2);
  });

  it('picks up, slides and drops with the remote (arrow keys + OK)', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    // Select the first Alpha Movie row, then OK to pick up.
    fireEvent.click(screen.getAllByRole('button', { name: /Alpha Movie/ }).find((element) => element.classList.contains('program'))!);
    const row = document.querySelector<HTMLButtonElement>('.program.cursor')!;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByText('moving')).toBeTruthy();
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    fireEvent.keyDown(document.querySelector('.program.cursor')!, { key: 'Enter' });
    expect(screen.queryByText('moving')).toBeNull();
    expect(screen.getByText('Moved “Alpha Movie” 2 places later')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(lineupOrder(requests)).toEqual(['flex', 'prog-custom', 'prog-alpha', '8f3c1b2a-0000-4000-8000-000000000002', 'redirect', 'prog-bravo']);
  });

  it('cancels a slide with Back and leaves the lineup untouched', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getAllByRole('button', { name: /Alpha Movie/ }).find((element) => element.classList.contains('program'))!);
    fireEvent.keyDown(document.querySelector('.program.cursor')!, { key: 'Enter' });
    fireEvent.keyDown(document.querySelector('.program.cursor')!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.querySelector('.program.cursor')!, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
  });

  it('moves a shift-selected block together', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.program')];
    const alpha = rows().find((element) => element.textContent?.includes('Alpha Movie'))!;
    fireEvent.click(alpha);
    const next = rows()[rows().indexOf(alpha) + 1];
    fireEvent.click(next, { shiftKey: true });
    expect(screen.getByText('2 programs selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(lineupOrder(requests)).toEqual(['prog-custom', 'prog-alpha', 'flex', '8f3c1b2a-0000-4000-8000-000000000002', 'redirect', 'prog-bravo']);
  });

  it('moves to a lineup position from the Move dialog', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Move or swap…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Lineup position'), { target: { value: '6' } });
    fireEvent.click(within(within(dialog).getByLabelText('Lineup position').closest('form')!).getByRole('button', { name: 'Move' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(lineupOrder(requests).at(-1)).toBe('prog-alpha');
  });

  it('previews and applies a move to a start time', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Move or swap…' }));
    const dialog = await screen.findByRole('dialog');
    // The fake channel starts at 23:00 the previous day; its cycle is 140 minutes.
    fireEvent.change(within(dialog).getByLabelText('Start near time'), { target: { value: '00:55:00' } });
    expect(within(dialog).getByText(/^Will start 00:/)).toBeTruthy();
    fireEvent.click(within(within(dialog).getByLabelText('Start near time').closest('form')!).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/^Moved “Alpha Movie” to start 00:/)).toBeTruthy();
  });

  it('runs commands from the pull-down menus', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Move Later/ }));
    expect(screen.getByText('Moved “Alpha Movie” later')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Keyboard & Remote Shortcuts/ }));
    expect(await screen.findByText('Keyboard & remote shortcuts')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('Keyboard & remote shortcuts')).toBeNull();
  });

  it('marks what is on air and shows day totals', async () => {
    fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    expect(screen.getByText('ON AIR')).toBeTruthy();
    expect(document.querySelector('.program.on-air .now-line')).toBeTruthy();
    const totals = screen.getByLabelText('Airtime this day');
    expect(within(totals).getByText('Content')).toBeTruthy();
    expect(within(totals).getByText('Flex')).toBeTruthy();
  });

  it('exports the day as a program log', async () => {
    fakeCompanion();
    let exported: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { exported = blob; return 'blob:log'; } });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Export Program Log/ }));
    expect(click).toHaveBeenCalledOnce();
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exported!);
    });
    click.mockRestore();
    expect(csv.split('\r\n')[0]).toBe('Date,Start,End,Duration,Type,Title,Detail,Lineup position');
    expect(csv).toContain('Alpha Movie');
    expect(csv).toContain('Channel Two');
  });

  it('asks before leaving demo edits to connect', async () => {
    fakeCompanion({ health: { status: 502, body: { status: 'unreachable', tunarrHost: 'tunarr:8000', error: { code: 'tunarr_unreachable', message: 'down' } } } });
    render(<Home />);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Use demo data' }));
    await screen.findByText('Studio Selects');
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Demo mode' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Connect to Tunarr' }));
    expect(within(await screen.findByRole('alertdialog')).getByText('Discard unsaved changes?')).toBeTruthy();
  });
});

describe('slot schedule editing', () => {
  const schedule = {
    type: 'random',
    maxDays: 2,
    randomDistribution: 'weighted',
    flexPreference: 'end',
    padMs: 0,
    slots: [
      { id: 's1', type: 'show', showId: 'show-1', show: { title: 'Bravo Show' }, order: 'next', direction: 'asc', weight: 3, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 } },
      { id: 's2', type: 'movie', order: 'shuffle', direction: 'asc', weight: 1, cooldownMs: 600000 },
    ],
  };

  it('edits slots, previews the regenerated lineup, then saves exactly that preview', async () => {
    const { requests, state } = fakeCompanion({ schedule });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Edit slot schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: /Slot schedule ·/ });
    expect(within(dialog).getByText(/Random slots \(weighted\) · 2 slots · generates 2 days/)).toBeTruthy();
    expect(within(dialog).getByText('75.0%')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Slot 2 weight'), { target: { value: '3' } });
    expect(within(dialog).getAllByText('50.0%')).toHaveLength(2);
    // Saving needs a preview of exactly this draft first.
    expect((within(dialog).getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview lineup' }));

    expect(await screen.findByRole('region', { name: 'Schedule preview' })).toBeTruthy();
    expect((state.previewedSlots as Array<{ weight: number }>)[1].weight).toBe(3);
    fireEvent.click(within(screen.getByRole('region', { name: 'Schedule preview' })).getByRole('button', { name: 'Save schedule' }));

    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith('/programming'))!;
    expect(post.body).toMatchObject({ type: 'random', seed: [11, 22], discardCount: 3 });
    expect((post.body as { schedule: { slots: Array<{ weight: number }> } }).schedule.slots.map((slot) => slot.weight)).toEqual([3, 3]);
    // The fake companion saves the reversed lineup, which is also what it previewed.
    expect(await screen.findByText(/Schedule saved exactly as previewed/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Schedule preview' })).toBeNull();
  });

  it('offers existing sources, every catalog source, and library shows', async () => {
    fakeCompanion({ schedule });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Edit slot schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: /Slot schedule ·/ });
    await waitFor(() => expect([...(within(dialog).getByLabelText('Slot 1 source') as unknown as HTMLSelectElement).options].map((option) => option.text)).toContain('Custom show: Marathon'));
    const texts = [...(within(dialog).getByLabelText('Slot 1 source') as unknown as HTMLSelectElement).options].map((option) => option.text);
    expect(texts).toEqual(expect.arrayContaining(['Bravo Show', 'Movies', 'Custom show: Marathon', 'Filler list: Station Ads', 'Redirect to CH 7 Movie Night', 'Flex (open airtime)', 'Another show from the library…']));
    expect(texts).not.toContain('Redirect to CH 3 Newsroom');
  });

  it('adds a slot with commercials and saves its settings', async () => {
    const { requests } = fakeCompanion({ schedule });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Edit slot schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: /Slot schedule ·/ });
    await waitFor(() => expect(within(within(dialog).getByLabelText('Add a slot')).getByRole('option', { name: 'Custom show: Marathon' })).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText('Add a slot'), { target: { value: `custom-show:${CUSTOM_ID}` } });
    expect(within(dialog).getByLabelText('Slot 3 source')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commercials for slot 3' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add commercials' }));
    fireEvent.click(within(dialog).getByLabelText('Mid-roll breaks inside programs'));
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Where commercial list 1 plays' })).getByLabelText('Mid-roll breaks'));
    fireEvent.change(within(dialog).getByDisplayValue('By weight'), { target: { value: 'none' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview lineup' }));
    fireEvent.click(within(await screen.findByRole('region', { name: 'Schedule preview' })).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    const body = requests.find((r) => r.method === 'POST' && r.path.endsWith('/programming'))!.body as { type: string; schedule: { settings: { randomDistribution: string }; slots: Array<Record<string, unknown>> } };
    expect(body.type).toBe('random');
    expect(body.schedule.settings.randomDistribution).toBe('none');
    expect(body.schedule.slots[2]).toMatchObject({ type: 'custom-show', customShowId: CUSTOM_ID, weight: 1, filler: [{ fillerListId: FILLER_ID, types: ['pre', 'mid'] }], midRoll: { maxBreaks: 3 } });
    expect(body.schedule.slots[2].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates a slot schedule for a manual channel', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Create Slot Schedule/ }));
    const dialog = await screen.findByRole('dialog', { name: /New slot schedule ·/ });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Time slots' }));
    await waitFor(() => expect(within(within(dialog).getByLabelText('Add a slot')).getByRole('option', { name: 'Movies' })).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText('Add a slot'), { target: { value: 'movie' } });
    fireEvent.change(within(dialog).getByLabelText('Slot 1 start'), { target: { value: '20:00:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview lineup' }));
    fireEvent.click(within(await screen.findByRole('region', { name: 'Schedule preview' })).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    const body = requests.find((r) => r.method === 'POST' && r.path.endsWith('/programming'))!.body as { type: string; schedule: { slots: Array<Record<string, unknown>> } };
    expect(body.type).toBe('time');
    expect(body.schedule.slots).toEqual([expect.objectContaining({ type: 'movie', startTime: 20 * 3_600_000 })]);
  });

  it('discards a preview with Back and leaves Tunarr untouched', async () => {
    const { requests } = fakeCompanion({ schedule });
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Edit slot schedule…' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /Slot schedule ·/ })).getByRole('button', { name: 'Preview lineup' }));
    await screen.findByRole('region', { name: 'Schedule preview' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Schedule preview' })).toBeNull();
    expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(0);
  });
});

describe('full lineup editing', () => {
  const posted = (requests: ReturnType<typeof fakeCompanion>['requests']) => (requests.find((r) => r.method === 'POST' && r.path.endsWith('/programming'))!.body as { lineup: LineupItem[] }).lineup;

  it('inserts programs from the library after the selection', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Insert…' }));
    const insert = await screen.findByRole('dialog', { name: 'Insert into the lineup' });
    fireEvent.click(within(insert).getByRole('button', { name: 'Browse library…' }));
    const library = await screen.findByRole('dialog', { name: 'Insert programs' });
    fireEvent.click(await within(library).findByRole('button', { name: 'Add Zulu Movie (1999)' }));
    fireEvent.click(within(library).getByRole('button', { name: 'Insert 1' }));
    expect(await screen.findByText('Inserted “Zulu Movie”')).toBeTruthy();
    expect(screen.getAllByText('Zulu Movie').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(posted(requests).slice(0, 2)).toEqual([mixedLineup()[0], { type: 'content', id: LIBRARY_MOVIE.uuid, duration: LIBRARY_MOVIE.duration }]);
  });

  it('inserts a commercial break that plays from filler lists', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.keyDown(document.body, { key: 'i' });
    const insert = await screen.findByRole('dialog', { name: 'Insert into the lineup' });
    fireEvent.click(within(insert).getByRole('radio', { name: 'Commercial break' }));
    fireEvent.click(await within(insert).findByLabelText(/Station Ads/));
    fireEvent.change(within(insert).getByLabelText('Length minutes'), { target: { value: '3' } });
    fireEvent.click(within(insert).getByRole('radio', { name: /Before/ }));
    fireEvent.click(within(insert).getByRole('button', { name: 'Insert' }));
    expect(await screen.findByText('Inserted a commercial break')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(posted(requests)[0]).toEqual({ type: 'flex', duration: 3 * 60_000, fillerConfig: { fillerListIds: [FILLER_ID], fillerRepeatCooldownMs: 0, origin: 'flex' } });
  });

  it('removes with Delete, changes a flex length, and undoes', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    // The fixture's flex entry plays from filler lists, so it is shown as a commercial break.
    const flexRow = [...document.querySelectorAll<HTMLButtonElement>('.program')].find((row) => row.textContent?.includes('Commercial break'))!;
    fireEvent.click(flexRow);
    fireEvent.change(screen.getByLabelText('Length minutes'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Changed “Commercial break” to 0:25:00')).toBeTruthy();
    const alpha = [...document.querySelectorAll<HTMLButtonElement>('.program')].find((row) => row.textContent?.includes('Alpha Movie'))!;
    fireEvent.click(alpha);
    fireEvent.keyDown(alpha, { key: 'Delete' });
    expect(screen.getByText('Removed “Alpha Movie”')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save lineup' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/channels/chan-news/programming')).toBe(1));
    expect(posted(requests).map((item) => [item.type, item.duration])).toEqual(mixedLineup().map((item) => [item.type, item.type === 'flex' ? 25 * 60_000 : item.duration]));
  });

  it('keeps inserted programs, with their titles, in a draft across a reload', async () => {
    fakeCompanion();
    const first = render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('button', { name: 'Insert…' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Insert into the lineup' })).getByRole('button', { name: 'Browse library…' }));
    const library = await screen.findByRole('dialog', { name: 'Insert programs' });
    fireEvent.click(await within(library).findByRole('button', { name: 'Add Zulu Movie (1999)' }));
    fireEvent.click(within(library).getByRole('button', { name: 'Insert 1' }));
    await waitFor(async () => expect((await draftStore().get('chan-news'))?.extras).toHaveLength(1));
    first.unmount();
    render(<Home />);
    expect(await screen.findByText(/Restored your unsaved changes/)).toBeTruthy();
    expect(screen.getAllByText('Zulu Movie').length).toBeGreaterThan(0);
  });
});

describe('lists and channel settings', () => {
  it('creates a filler list from library programs', async () => {
    const { requests } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lists' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Filler Lists/ }));
    const manager = await screen.findByRole('dialog', { name: /Filler lists/ });
    expect(await within(manager).findByText('Station Ads')).toBeTruthy();
    fireEvent.click(within(manager).getByRole('button', { name: 'New filler list' }));
    fireEvent.change(within(manager).getByLabelText('List name'), { target: { value: 'Bumpers' } });
    fireEvent.click(within(manager).getByRole('button', { name: 'Add programs…' }));
    const library = await screen.findByRole('dialog', { name: 'Add to Bumpers' });
    fireEvent.click(await within(library).findByRole('button', { name: 'Add Zulu Movie (1999)' }));
    fireEvent.click(within(library).getByRole('button', { name: 'Add 1' }));
    fireEvent.click(within(manager).getByRole('button', { name: 'Create filler list' }));
    await waitFor(() => expect(count(requests, 'POST', '/api/tunarr/filler-lists')).toBe(1));
    expect(requests.find((r) => r.method === 'POST' && r.path === '/api/tunarr/filler-lists')!.body).toEqual({ name: 'Bumpers', programs: [{ type: 'content', id: LIBRARY_MOVIE.uuid, duration: LIBRARY_MOVIE.duration, program: LIBRARY_MOVIE }] });
    expect(await within(manager).findByText('Bumpers', { selector: 'b' })).toBeTruthy();
  });

  it('adds channel-wide commercials for flex time', async () => {
    const { requests, state } = fakeCompanion();
    render(<Home />);
    await screen.findAllByText('Alpha Movie');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Channel Settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Channel settings' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add filler list' }));
    fireEvent.change(within(dialog).getByLabelText('Filler list 1 weight'), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('Filler list 1 cooldown minutes'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(count(requests, 'PUT', '/api/tunarr/channels/chan-news/settings')).toBe(1));
    expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({ fillerCollections: [{ id: FILLER_ID, weight: 5, cooldownSeconds: 600 }] });
    expect(state.settings.fillerCollections).toHaveLength(1);
    expect(await screen.findByText('Channel settings saved to Tunarr')).toBeTruthy();
  });
});
