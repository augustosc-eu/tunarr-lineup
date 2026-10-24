// Bounded, cancellable loading in the browser: the API client's phases,
// timeouts and cancellation (lib/tunarrClient.ts, lib/loading.ts), draft
// stores that hang or fail (lib/draftStore.ts), the timeline's row window
// (lib/rowWindow.ts) and the channel the desk opens on (lib/lastChannel.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionDrafts, createDraftStore, REMOTE_RETRY_MS, sharedDraftStore, type CompanionDrafts, type StoredDraft } from '../lib/draftStore';
import { addressWithChannel, channelFromQuery, LAST_CHANNEL_KEY, pickChannel, readLastChannel, writeLastChannel } from '../lib/lastChannel';
import { formatBytes, linkedSignal, loadingCopy, settleWithin, withTimeout, type LoadPhase } from '../lib/loading';
import { ROW_WINDOW, rowWindow, shiftWindow } from '../lib/rowWindow';
import { isAborted, tunarrApi, TunarrApiError } from '../lib/tunarrClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const draft = (channelId: string, updatedAt = 1): StoredDraft => ({ channelId, version: 'v1', updatedAt, dirty: true, current: [1, 0], past: [], future: [] });

/** An IDBFactory whose open() never answers, like some Safari versions after a crash. */
const hangingIndexedDb = () => ({ open: () => ({}) }) as unknown as IDBFactory;

describe('bounded waits', () => {
  it('settles within the limit, or hands back the promise for later', async () => {
    expect(await settleWithin(Promise.resolve(3), 50)).toEqual({ settled: true, value: 3 });
    let release!: (value: number) => void;
    const slow = new Promise<number>((resolve) => { release = resolve; });
    const result = await settleWithin(slow, 10);
    expect(result.settled).toBe(false);
    release(7);
    expect(await (result as { late: Promise<number> }).late).toBe(7);
  });

  it('rejects work that takes too long', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, () => new Error('slow'))).rejects.toThrow('slow');
    await expect(withTimeout(Promise.resolve('ok'), 10, () => new Error('slow'))).resolves.toBe('ok');
  });

  it('links a parent signal and a timeout without AbortSignal.any', async () => {
    const parent = new AbortController();
    const linked = linkedSignal(parent.signal, 0);
    parent.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false);
    const timed = linkedSignal(undefined, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timed.signal.aborted).toBe(true);
    expect(timed.timedOut()).toBe(true);
  });

  it('describes each stage of loading', () => {
    expect(loadingCopy({ channelId: 'a', phase: 'connecting' }).title).toBe('Connecting to Tunarr…');
    expect(loadingCopy({ channelId: 'a', phase: 'downloading', received: 1_572_864, total: 3_145_728 }).text).toBe('1.5 MB of 3.0 MB received.');
    expect(loadingCopy({ channelId: 'a', phase: 'processing' }).title).toBe('Preparing the lineup…');
    expect(loadingCopy({ channelId: 'a', phase: 'cancelled' }).title).toBe('Loading cancelled');
    expect(formatBytes(512)).toBe('512 B');
  });
});

describe('API client', () => {
  it('reports connecting, downloading and processing while it reads a body', async () => {
    const encoder = new TextEncoder();
    const body = JSON.stringify({ lineup: Array.from({ length: 500 }, (_, index) => ({ type: 'flex', duration: index + 1 })) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, 1000)));
        controller.enqueue(encoder.encode(body.slice(1000)));
        controller.close();
      },
    }), { headers: { 'content-length': String(body.length) } })));
    const phases: LoadPhase[] = [];
    const data = await tunarrApi.programming('chan', { onPhase: (phase) => phases.push(phase) });
    expect(data.lineup).toHaveLength(500);
    expect(phases[0]).toEqual({ phase: 'connecting' });
    expect(phases.some((phase) => phase.phase === 'downloading' && phase.total === body.length)).toBe(true);
    expect(phases.at(-1)).toEqual({ phase: 'processing' });
  });

  it('turns a cancelled request into an "aborted" error that the desk ignores', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const controller = new AbortController();
    const pending = tunarrApi.programming('chan', { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(isAborted(error)).toBe(true);
  });

  it('gives up on a server that never answers, with a message saying so', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const error = await tunarrApi.channels({ timeoutMs: 20 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TunarrApiError);
    expect((error as TunarrApiError).code).toBe('client_timeout');
    expect(isAborted(error)).toBe(false);
  });

  it('times out a body that stops arriving halfway', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"lineup":['));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    }))));
    const error = await tunarrApi.programming('chan', { timeoutMs: 30, onPhase: () => {} }).catch((caught: unknown) => caught);
    expect((error as TunarrApiError).code).toBe('client_timeout');
  });
});

describe('draft stores that hang or fail', () => {
  it('falls back to memory when IndexedDB never answers', async () => {
    const store = createDraftStore(hangingIndexedDb(), 30);
    const started = Date.now();
    expect(await store.get('chan')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(store.persistent).toBe(false);
    // Later calls go straight to memory and keep working.
    await store.put(draft('chan'));
    expect((await store.get('chan'))?.channelId).toBe('chan');
  });

  it('falls back to memory when opening IndexedDB throws', async () => {
    const store = createDraftStore({ open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory, 30);
    await store.put(draft('chan'));
    expect((await store.get('chan'))?.channelId).toBe('chan');
    expect(store.persistent).toBe(false);
  });

  it('gives up on the companion’s copy when it is slow, and keeps the local one', async () => {
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    const remote = companionDrafts(hanging as unknown as typeof fetch, 30);
    const local = createDraftStore(undefined);
    await local.put(draft('chan'));
    const store = sharedDraftStore(local, remote);
    const started = Date.now();
    expect((await store.get('chan'))?.channelId).toBe('chan');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(store.shared).toBe(false);
  });

  it('takes the companion’s newer copy, and tries again after it was unreachable', async () => {
    let now = 0;
    let up = false;
    const remote: CompanionDrafts = {
      list: vi.fn(async () => { if (!up) throw new Error('down'); return []; }),
      get: vi.fn(async () => draft('chan', 50)),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    const local = createDraftStore(undefined);
    await local.put(draft('chan', 10));
    const store = sharedDraftStore(local, remote, () => now);
    expect((await store.get('chan'))?.updatedAt).toBe(10);
    up = true;
    now += REMOTE_RETRY_MS - 1;
    expect((await store.get('chan'))?.updatedAt).toBe(10);
    now += 1;
    expect((await store.get('chan'))?.updatedAt).toBe(50);
    expect(store.shared).toBe(true);
  });
});

describe('row window', () => {
  it('mounts a short day whole', () => {
    expect(rowWindow(120, 50, null)).toEqual({ start: 0, end: 120 });
  });

  it('mounts a window around the focus, a third of the way down', () => {
    expect(rowWindow(1_500, 600, null)).toEqual({ start: 600 - Math.floor(ROW_WINDOW / 3), end: 600 - Math.floor(ROW_WINDOW / 3) + ROW_WINDOW });
    expect(rowWindow(1_500, 3, null).start).toBe(0);
    expect(rowWindow(1_500, 1_499, null).end).toBe(1_500);
  });

  it('stays put while the focus is inside, and follows it out', () => {
    expect(rowWindow(1_500, 450, 400)).toEqual({ start: 400, end: 600 });
    expect(rowWindow(1_500, 600, 400).start).toBe(600 - Math.floor(ROW_WINDOW / 3));
    expect(rowWindow(1_500, 399, 400).start).toBe(399 - Math.floor(ROW_WINDOW / 3));
  });

  it('stays where it was moved by hand, away from the cursor, until the cursor moves', () => {
    // Show earlier with the cursor at row 1,450: the window leaves it behind.
    expect(rowWindow(1_500, -1, 1_200)).toEqual({ start: 1_200, end: 1_400 });
    // The cursor moves again: the window follows it.
    expect(rowWindow(1_500, 1_000, 1_200).start).toBe(1_000 - Math.floor(ROW_WINDOW / 3));
  });

  it('moves by a step within the day', () => {
    expect(shiftWindow({ start: 0, end: 200 }, 1_500, 100)).toEqual({ start: 100, end: 300 });
    expect(shiftWindow({ start: 1_250, end: 1_450 }, 1_500, 100)).toEqual({ start: 1_300, end: 1_500 });
    expect(shiftWindow({ start: 50, end: 250 }, 1_500, -100)).toEqual({ start: 0, end: 200 });
  });
});

describe('the channel the desk opens on', () => {
  const channels = [{ id: 'a1', name: 'One' }, { id: 'b2', name: 'Two' }, { id: 'c3', name: 'Three' }];

  it('reads ?channel= only when it is a well-formed id', () => {
    expect(channelFromQuery('?channel=b2')).toBe('b2');
    expect(channelFromQuery('?x=1')).toBeNull();
    expect(channelFromQuery('?channel=')).toBeNull();
    expect(channelFromQuery('?channel=../../etc')).toEqual({ invalid: true });
  });

  it('prefers the open channel, then the address, then the last one opened, then the first', () => {
    expect(pickChannel(channels, { preferred: 'c3', fromQuery: 'b2', remembered: 'a1' }).channel?.id).toBe('c3');
    expect(pickChannel(channels, { fromQuery: 'b2', remembered: 'c3' }).channel?.id).toBe('b2');
    expect(pickChannel(channels, { remembered: 'c3' }).channel?.id).toBe('c3');
    expect(pickChannel(channels, { remembered: 'gone' }).channel?.id).toBe('a1');
    expect(pickChannel([], {}).channel).toBeUndefined();
  });

  it('says so when the address names a channel this server doesn’t have', () => {
    const missing = pickChannel(channels, { fromQuery: 'zz9' });
    expect(missing.channel?.id).toBe('a1');
    expect(missing.note).toBe('The channel in this address isn’t on this Tunarr server, so One opened instead.');
    expect(pickChannel(channels, { fromQuery: { invalid: true } }).note).toContain('isn’t on this Tunarr server');
    expect(pickChannel(channels, { fromQuery: 'b2' }).note).toBe('');
  });

  it('remembers the last channel where storage works, and shrugs where it throws', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeLastChannel(storage, 'b2');
    expect(values.get(LAST_CHANNEL_KEY)).toBe('b2');
    expect(readLastChannel(storage)).toBe('b2');
    values.set(LAST_CHANNEL_KEY, '<script>');
    expect(readLastChannel(storage)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readLastChannel(broken)).toBeNull();
    expect(() => writeLastChannel(broken, 'b2')).not.toThrow();
    expect(readLastChannel(undefined)).toBeNull();
  });

  it('keeps the path and other parameters when the address follows the channel', () => {
    expect(addressWithChannel('https://tv.example.test/lineup/?channel=a1&x=2#top', 'b2')).toBe('/lineup/?channel=b2&x=2#top');
  });
});
