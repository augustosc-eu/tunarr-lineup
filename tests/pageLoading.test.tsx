// @vitest-environment jsdom
// Loading channels on the desk: draft stores that hang, cancellation and
// channel switches, large days, retries, the channel in the address, and
// nothing happening after the desk is gone. Uses its own small fake companion.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../app/page';
import { companionDrafts, createDraftStore, sharedDraftStore, type DraftStore, type StoredDraft } from '../lib/draftStore';
import { dayRange, type LineupItem } from '../lib/lineup';
import { LAST_CHANNEL_KEY } from '../lib/lastChannel';
import { ROW_WINDOW } from '../lib/rowWindow';
import { programmingVersion } from '../server/lineupVersion';

const control = vi.hoisted(() => ({ store: null as DraftStore | null }));
vi.mock('../lib/draftStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/draftStore')>();
  return { ...actual, draftStore: () => control.store ?? actual.draftStore() };
});

const MINUTE = 60_000;
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const startTime = () => dayRange(today()).from.getTime() - 60 * MINUTE;
const id = (n: number) => `0b6f5c4e-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;

/** `count` programs of `minutes` each, titled "Show 1", "Show 2"… */
function lineupOf(count: number, minutes: number) {
  const lineup: LineupItem[] = Array.from({ length: count }, (_, index) => ({ type: 'content', id: id(index + 1), duration: minutes * MINUTE }));
  const programs = Object.fromEntries(lineup.map((item, index) => [item.id!, { type: 'content', id: item.id, program: { type: 'movie', title: `Show ${index + 1}` } }]));
  return { lineup, programs };
}

type Pending = { release: (body?: unknown, status?: number) => void; signal?: AbortSignal | null };

/**
 * The companion's routes the desk calls while loading. A channel's
 * programming can be held back (`hold`) to test switching and cancelling.
 */
function fakeCompanion(lineups: Record<string, { lineup: LineupItem[]; programs: Record<string, unknown> }>, options: { remoteDrafts?: 'hang' | 'fail' | 'ok'; failFirst?: string; guideHold?: boolean } = {}) {
  const channels = Object.keys(lineups).map((key, index) => ({ id: key, name: `Channel ${key}`, number: index + 1, startTime: startTime(), duration: 0, programCount: lineups[key].lineup.length }));
  const requests: Array<{ method: string; path: string; signal?: AbortSignal | null }> = [];
  const held = new Map<string, Pending[]>();
  const hold = new Set<string>();
  const failures = new Set(options.failFirst ? [options.failFirst] : []);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const deferred = (key: string, signal: AbortSignal | null | undefined, body: () => unknown) => new Promise<Response>((resolve, reject) => {
    const entry: Pending = { signal, release: (override, status = 200) => resolve(json(override ?? body(), status)) };
    held.set(key, [...(held.get(key) ?? []), entry]);
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://lineup.local');
    const method = init?.method ?? 'GET';
    requests.push({ method, path: url.pathname, signal: init?.signal });
    const path = url.pathname;
    if (path === '/api/tunarr/health') return json({ status: 'connected', tunarrHost: 'tunarr:8000', channelCount: channels.length });
    if (path === '/api/tunarr/channels') return json(channels);
    if (path.startsWith('/api/tunarr/drafts')) {
      if (options.remoteDrafts === 'hang') return new Promise<Response>(() => {});
      if (options.remoteDrafts === 'fail') return json({ error: { code: 'boom', message: 'Boom' } }, 500);
      return json(path === '/api/tunarr/drafts' ? [] : null);
    }
    const match = /^\/api\/tunarr\/channels\/([^/]+)\/(programming|lineup|settings)$/.exec(path);
    if (match?.[2] === 'programming' && method === 'GET') {
      const data = lineups[match[1]];
      const body = () => ({ lineup: data.lineup, programs: data.programs, totalPrograms: data.lineup.length });
      if (failures.delete(match[1])) return json({ error: { code: 'tunarr_unreachable', message: 'Tunarr at tunarr:8000 is unreachable.' } }, 502);
      if (hold.has(match[1])) return deferred(match[1], init?.signal, body);
      return json(body());
    }
    if (match?.[2] === 'lineup') {
      if (options.guideHold) return deferred(`guide:${match[1]}`, init?.signal, () => ({ programs: [] }));
      return json({ programs: [] });
    }
    if (match?.[2] === 'settings') return json({ id: match[1], fillerCollections: [] });
    if (path === '/api/tunarr/sessions') return json({});
    if (path === '/api/tunarr/ai') return json({ enabled: false, message: 'off' });
    if (path === '/api/tunarr/scheduled') return json({ enabled: false, changes: [] });
    if (path === '/api/tunarr/filler-lists' || path === '/api/tunarr/custom-shows') return json([]);
    if (path === '/api/tunarr/filler-roles' || path === '/api/tunarr/station-ids') return json({});
    return json({ error: { code: 'route_not_allowed', message: 'Not in this fake.' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    requests,
    hold: (channelId: string) => hold.add(channelId),
    release: (key: string, body?: unknown, status?: number) => { const next = held.get(key)?.shift(); next?.release(body, status); return next; },
    pending: (key: string) => held.get(key) ?? [],
    programmingGets: (channelId: string) => requests.filter((request) => request.method === 'GET' && request.path === `/api/tunarr/channels/${channelId}/programming`),
  };
}

const rows = () => document.querySelectorAll('.program');
/** Every row of the day is mounted (a short day isn't windowed). */
const wholeDay = () => rows().length > 0 && rows().length === Number(document.querySelector('.day-count')?.textContent?.replace(/\D/g, ''));
const rowTitles = () => [...rows()].map((row) => row.querySelector('.program-copy b')?.textContent ?? '');
const memoryStore = () => sharedDraftStore(createDraftStore(undefined), companionDrafts((...args) => fetch(...args), 200));

/** This jsdom has no localStorage of its own; each test gets a fresh one. */
function installStorage() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, String(value)); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(), key: () => null, length: 0 };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => storage });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  installStorage();
  control.store = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a draft store that never answers', () => {
  it('shows the lineup when IndexedDB hangs, then keeps edits in memory', async () => {
    fakeCompanion({ small: lineupOf(15, 30) });
    control.store = sharedDraftStore(createDraftStore({ open: () => ({}) } as unknown as IDBFactory, 200), companionDrafts((...args) => fetch(...args), 200));
    render(<Home />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 3_000 });
    expect(document.querySelector('.timeline.loading')).toBeNull();
    expect(screen.queryByText('Connecting to Tunarr…')).toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(async () => expect((await control.store!.get('small'))?.dirty).toBe(true));
    expect(control.store.persistent).toBe(true); // The companion keeps a copy, so a reload doesn't lose it.
  });

  it('shows the lineup after a short wait even when the whole store hangs, and writes nothing over the draft', async () => {
    fakeCompanion({ small: lineupOf(15, 30) });
    const put = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    control.store = { persistent: true, get: () => new Promise<StoredDraft | undefined>(() => {}), put, delete: remove, list: async () => [] };
    render(<Home />);
    await waitFor(() => expect(wholeDay()).toBe(true), { timeout: 4_000 });
    fireEvent.keyDown(window, { key: 'Delete' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('still restores the local draft when the companion’s copy is slow or fails', async () => {
    for (const remoteDrafts of ['hang', 'fail'] as const) {
      const data = lineupOf(15, 30);
      fakeCompanion({ small: data }, { remoteDrafts });
      const local = createDraftStore(undefined);
      await local.put({ channelId: 'small', version: programmingVersion(data.lineup, undefined), updatedAt: Date.now(), dirty: true, current: data.lineup.map((_, index) => data.lineup.length - 1 - index), past: [], future: [] });
      control.store = sharedDraftStore(local, companionDrafts((...args) => fetch(...args), 200));
      render(<Home />);
      await screen.findByText(/Restored your unsaved changes/, undefined, { timeout: 3_000 });
      cleanup();
    }
  });
});

describe('channels of every size', () => {
  it('says when a channel has nothing scheduled', async () => {
    fakeCompanion({ empty: { lineup: [], programs: {} } });
    render(<Home />);
    expect(await screen.findByText('No programming yet')).toBeTruthy();
  });

  it('mounts every row of a small channel’s day', async () => {
    fakeCompanion({ small: lineupOf(15, 30) });
    control.store = memoryStore();
    render(<Home />);
    await waitFor(() => expect(wholeDay()).toBe(true));
    expect(screen.queryByText(/Show later programs/)).toBeNull();
  });

  it('mounts a window of a 5,000-item channel’s day and follows the cursor through it', async () => {
    const data = lineupOf(5_000, 0.5);
    fakeCompanion({ large: data });
    control.store = memoryStore();
    const started = performance.now();
    render(<Home />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 5_000 });
    const openMs = performance.now() - started;
    expect(document.querySelector('.day-count')?.textContent).toBe('2880 programs');
    expect(rows().length).toBeLessThanOrEqual(ROW_WINDOW);
    expect(screen.queryByText(/Show later programs/) ?? screen.queryByText(/Show earlier programs/)).toBeTruthy();

    // Arrow keys past the edge of the window (towards whichever side has more of
    // the day; on-air depends on the clock): the window moves, the cursor row stays mounted.
    const down = !!screen.queryByText(/Show later programs/);
    const before = rowTitles()[0];
    for (let step = 0; step < ROW_WINDOW + 20; step += 1) fireEvent.keyDown(window, { key: down ? 'ArrowDown' : 'ArrowUp' });
    await waitFor(() => expect(rowTitles()[0]).not.toBe(before));
    expect(document.querySelector('.program.cursor')).toBeTruthy();
    expect(rows().length).toBeLessThanOrEqual(ROW_WINDOW);

    const first = rowTitles()[0];
    fireEvent.click(screen.queryByText(/Show earlier programs/) ?? screen.getByText(/Show later programs/));
    await waitFor(() => expect(rowTitles()[0]).not.toBe(first));
    expect(rows().length).toBeLessThanOrEqual(ROW_WINDOW);
    console.log(`[perf] ${JSON.stringify({ scenario: 'jsdom-large-5000', openMs: Math.round(openMs), rows: rows().length })}`);
    expect(openMs).toBeLessThan(5_000);
  });
});

describe('switching and cancelling', () => {
  it('drops a slow channel when another is picked, and cancels its download', async () => {
    const companion = fakeCompanion({ slow: lineupOf(15, 30), fast: lineupOf(10, 45) });
    control.store = memoryStore();
    companion.hold('slow');
    render(<Home />);
    await waitFor(() => expect(companion.pending('slow')).toHaveLength(1));
    const slowRequest = companion.pending('slow')[0];
    fireEvent.click(screen.getByText('Channel fast'));
    await waitFor(() => expect(wholeDay()).toBe(true));
    expect(slowRequest.signal?.aborted).toBe(true);
    companion.release('slow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector('.channel.active')?.textContent).toContain('Channel fast');
    expect(rowTitles()[0]).toMatch(/^Show /);
    expect(wholeDay()).toBe(true);
  });

  it('cancels a slow load on request, then tries again', async () => {
    const companion = fakeCompanion({ slow: lineupOf(15, 30) });
    control.store = memoryStore();
    companion.hold('slow');
    render(<Home />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Loading cancelled')).toBeTruthy();
    expect(companion.pending('slow')[0].signal?.aborted).toBe(true);
    companion.programmingGets('slow');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(companion.pending('slow')).toHaveLength(2));
    companion.pending('slow')[1].release();
    await waitFor(() => expect(wholeDay()).toBe(true));
  });

  it('shows how much has downloaded while a large lineup arrives', async () => {
    const data = lineupOf(2_000, 30);
    const body = JSON.stringify({ lineup: data.lineup, programs: data.programs });
    let finish!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://lineup.local').pathname;
      const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (path === '/api/tunarr/health') return reply({ status: 'connected', tunarrHost: 'tunarr:8000', channelCount: 1 });
      if (path === '/api/tunarr/channels') return reply([{ id: 'big', name: 'Channel big', number: 1, startTime: startTime(), duration: 0 }]);
      if (path === '/api/tunarr/channels/big/programming') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body.slice(0, 50_000)));
            finish = () => { controller.enqueue(new TextEncoder().encode(body.slice(50_000))); controller.close(); };
          },
        }), { headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
      }
      return reply(path.startsWith('/api/tunarr/drafts') && path !== '/api/tunarr/drafts' ? null : []);
    }));
    control.store = memoryStore();
    render(<Home />);
    expect(await screen.findByText('Downloading the lineup…')).toBeTruthy();
    expect(screen.getByText(/49 KB of \d+ KB received/)).toBeTruthy();
    act(() => finish());
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  });
});

describe('drafts take priority over Tunarr’s lineup', () => {
  const reversed = (data: { lineup: LineupItem[] }): StoredDraft => ({ channelId: 'small', version: programmingVersion(data.lineup, undefined), updatedAt: Date.now(), dirty: true, current: data.lineup.map((_, index) => data.lineup.length - 1 - index), past: [{ label: 'Reversed', before: data.lineup.map((_, index) => index), after: data.lineup.map((_, index) => data.lineup.length - 1 - index), blockBefore: { start: 0, end: 0 }, blockAfter: { start: 0, end: 0 } }], future: [] });

  it('opens on the stored draft when it is read in time', async () => {
    const data = lineupOf(6, 240);
    fakeCompanion({ small: data });
    control.store = memoryStore();
    await control.store.put(reversed(data));
    render(<Home />);
    await screen.findByText('Restored your unsaved changes (1 edit).');
    expect(rowTitles()[0]).toBe('Show 6');
  });

  it('applies a draft that arrives after the lineup was shown, if nothing was edited meanwhile', async () => {
    const data = lineupOf(6, 240);
    fakeCompanion({ small: data });
    const store = memoryStore();
    await store.put(reversed(data));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    control.store = { ...store, persistent: true, get: async (channelId) => { await gate; return store.get(channelId); }, put: store.put, delete: store.delete, list: store.list };
    render(<Home />);
    await waitFor(() => expect(rowTitles()[0]).toBe('Show 1'), { timeout: 4_000 });
    release();
    await screen.findByText('Restored your unsaved changes (1 edit).');
    expect(rowTitles()[0]).toBe('Show 6');
  });

  it('keeps new edits when an older draft turns up late', async () => {
    const data = lineupOf(6, 240);
    fakeCompanion({ small: data });
    const store = memoryStore();
    await store.put(reversed(data));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    control.store = { ...store, persistent: true, get: async (channelId) => { await gate; return store.get(channelId); }, put: store.put, delete: store.delete, list: store.list };
    render(<Home />);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 4_000 });
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(document.querySelector('.edit-list')?.textContent ?? '').toMatch(/Removed/));
    release();
    await screen.findByText(/turned up after you started editing/);
    expect(rowTitles()[0]).not.toBe('Show 6');
  });
});

describe('dates, retries and leaving', () => {
  it('changes day without downloading the lineup again, cancelling the old day’s guide', async () => {
    const companion = fakeCompanion({ small: lineupOf(15, 30) }, { guideHold: true });
    control.store = memoryStore();
    render(<Home />);
    await waitFor(() => expect(wholeDay()).toBe(true));
    await waitFor(() => expect(companion.pending('guide:small')).toHaveLength(1));
    const firstGuide = companion.pending('guide:small')[0];
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(companion.pending('guide:small')).toHaveLength(2));
    expect(firstGuide.signal?.aborted).toBe(true);
    expect(companion.programmingGets('small')).toHaveLength(1);
    // The rows stay usable while the guide loads.
    expect(document.querySelector('.timeline.loading')).toBeNull();
  });

  it('offers Try again after a failed load, and it works', async () => {
    const companion = fakeCompanion({ small: lineupOf(15, 30) }, { failFirst: 'small' });
    control.store = memoryStore();
    render(<Home />);
    expect(await screen.findByText('Couldn’t load this channel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(wholeDay()).toBe(true));
    expect(companion.programmingGets('small')).toHaveLength(2);
  });

  it('stops loading and changes nothing once the desk is gone', async () => {
    const companion = fakeCompanion({ slow: lineupOf(15, 30) });
    control.store = memoryStore();
    companion.hold('slow');
    const errors = vi.spyOn(console, 'error');
    const { unmount } = render(<Home />);
    await waitFor(() => expect(companion.pending('slow')).toHaveLength(1));
    const pending = companion.pending('slow')[0];
    unmount();
    expect(pending.signal?.aborted).toBe(true);
    const seen = companion.requests.length;
    pending.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(companion.requests.length).toBe(seen);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('the channel the desk opens on', () => {
  it('opens the channel named in the address', async () => {
    fakeCompanion({ a1: lineupOf(15, 30), b2: lineupOf(10, 45) });
    control.store = memoryStore();
    window.history.replaceState(null, '', '/?channel=b2');
    render(<Home />);
    await waitFor(() => expect(document.querySelector('.channel.active')?.textContent).toContain('Channel b2'));
  });

  it('says so when the address names a channel that isn’t there, and opens the first', async () => {
    fakeCompanion({ a1: lineupOf(15, 30), b2: lineupOf(10, 45) });
    control.store = memoryStore();
    window.history.replaceState(null, '', '/?channel=gone');
    render(<Home />);
    expect(await screen.findByText('The channel in this address isn’t on this Tunarr server, so Channel a1 opened instead.')).toBeTruthy();
    expect(document.querySelector('.channel.active')?.textContent).toContain('Channel a1');
  });

  it('reopens the last channel, and keeps the address in step when it names one', async () => {
    fakeCompanion({ a1: lineupOf(15, 30), b2: lineupOf(10, 45) });
    control.store = memoryStore();
    window.localStorage.setItem(LAST_CHANNEL_KEY, 'b2');
    render(<Home />);
    await waitFor(() => expect(document.querySelector('.channel.active')?.textContent).toContain('Channel b2'));
    cleanup();

    window.history.replaceState(null, '', '/?channel=b2');
    render(<Home />);
    await waitFor(() => expect(wholeDay()).toBe(true));
    fireEvent.click(screen.getByText('Channel a1'));
    await waitFor(() => expect(window.location.search).toBe('?channel=a1'));
    expect(window.localStorage.getItem(LAST_CHANNEL_KEY)).toBe('a1');
  });
});
