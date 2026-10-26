import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelFindings, findLoop, healthStatus, loopFindings, positionAt, sortFindings } from '../server/channelHealth';
import { checkChannels, controlRoomSummary, MAX_CHECK_CHANNELS, validateCheck } from '../server/controlRoom';
import { compatibility } from '../server/compatibility';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';
import { channelStatus, checkBatches, checkStream, filterCounts, matchesFilter, nextFilter, stepRow, summaryNotes, type ChannelSummary } from '../lib/controlRoom';
import { testDataDir } from './tempData';

const A = '960f0f1e-6b20-4422-9af3-91b5705a3933';
const B = '03211527-b3eb-4a63-87fb-0bbebd9ecaa5';
const C = '11111111-b3eb-4a63-87fb-0bbebd9ecaa5';
const P1 = '0b6f5c4e-1a2b-4c3d-8e9f-000000000001';
const P2 = '0b6f5c4e-1a2b-4c3d-8e9f-000000000002';
const LIST = '5e5e5e5e-1a2b-4c3d-8e9f-000000000001';
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 20);
const names = new Map([[A, 'CH 1 One'], [B, 'CH 2 Two'], [C, 'CH 3 Three']]);
const target = { origin: 'http://tunarr:8000', basePath: '', host: 'tunarr:8000' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const text = (response: { body: string | Uint8Array }) => (typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

describe('channel health rules', () => {
  const base = { channelId: A, channelNames: names, fillerListIds: new Set([LIST]), guideNow: null, now: NOW };

  it('finds programs Tunarr no longer has, items without length, and bad redirects', () => {
    const result = channelFindings({
      ...base,
      channel: { startTime: NOW - 10 * MIN, fillerCollections: [{ id: LIST }] },
      programming: {
        lineup: [
          { type: 'content', id: P1, duration: 30 * MIN },
          { type: 'content', id: P2, duration: 30 * MIN },
          { type: 'flex', duration: 0 },
          { type: 'redirect', channel: A, duration: 10 * MIN },
          { type: 'redirect', channel: 'gone-channel', duration: 10 * MIN },
        ],
        programs: { [P1]: { title: 'One' } },
      },
    });
    expect(result.mode).toBe('manual');
    expect(result.items).toBe(5);
    expect(result.cycleMs).toBe(80 * MIN);
    expect(result.findings.map((finding) => finding.id)).toEqual(['missing-program', 'zero-length', 'redirect-self-3', 'redirect-missing-4']);
    expect(result.findings[0]).toMatchObject({ severity: 'error', lineupIndex: 1, title: '1 program Tunarr no longer has' });
    expect(result.redirects).toEqual([A, 'gone-channel']);
  });

  it('flags flex with no filler only when the channel’s lists are known to be empty', () => {
    const lineup = [{ type: 'content', id: P1, duration: 30 * MIN }, { type: 'flex', duration: 15 * MIN }, { type: 'flex', duration: 2 * MIN, fillerConfig: { fillerListIds: [LIST] } }];
    const programming = { lineup, programs: { [P1]: {} } };
    expect(channelFindings({ ...base, programming, channel: { fillerCollections: [] } }).findings.map((finding) => finding.id)).toEqual(['flex-offline']);
    expect(channelFindings({ ...base, programming, channel: { fillerCollections: [{ id: LIST }] } }).findings).toEqual([]);
    // Unknown (Tunarr didn't send it): nothing is claimed.
    expect(channelFindings({ ...base, programming, channel: {} }).findings).toEqual([]);
  });

  it('flags breaks filled from a deleted filler list', () => {
    const programming = { lineup: [{ type: 'flex', duration: 2 * MIN, fillerConfig: { fillerListIds: ['deleted-list'] } }], programs: {} };
    expect(channelFindings({ ...base, programming, channel: {} }).findings.map((finding) => finding.id)).toEqual(['break-missing-list']);
    expect(channelFindings({ ...base, fillerListIds: null, programming, channel: {} }).findings).toEqual([]);
  });

  it('claims guide drift only on a manual lineup when both name different programs', () => {
    const programming = { lineup: [{ type: 'content', id: P1, duration: 30 * MIN }, { type: 'content', id: P2, duration: 30 * MIN }], programs: { [P1]: {}, [P2]: {} } };
    const channel = { startTime: NOW - 10 * MIN };
    expect(channelFindings({ ...base, programming, channel, guideNow: { type: 'content', id: P2, title: 'Two' } }).findings.map((finding) => finding.id)).toEqual(['guide-drift']);
    expect(channelFindings({ ...base, programming, channel, guideNow: { type: 'content', id: P1 } }).findings).toEqual([]);
    expect(channelFindings({ ...base, programming, channel, guideNow: { type: 'flex' } }).findings).toEqual([]);
    expect(channelFindings({ ...base, programming: { ...programming, schedule: { type: 'random' } }, channel, guideNow: { type: 'content', id: P2 } }).findings).toEqual([]);
  });

  it('walks the cycle to find what airs', () => {
    const lineup = [{ duration: 10 * MIN }, { duration: 20 * MIN }];
    expect(positionAt(lineup, 0, 5 * MIN)).toBe(0);
    expect(positionAt(lineup, 0, 15 * MIN)).toBe(1);
    expect(positionAt(lineup, 0, 35 * MIN)).toBe(0);
    expect(positionAt(lineup, 10 * MIN, 0)).toBe(-1);
    expect(positionAt([], 0, 0)).toBe(-1);
  });

  it('finds loops across channels and says when the check is partial', () => {
    const edges = new Map([[A, [B]], [B, [C]], [C, [A]]]);
    expect(findLoop(A, edges)).toEqual([A, B, C, A]);
    expect(loopFindings(A, edges, names)[0]).toMatchObject({ id: 'redirect-loop', detail: expect.stringContaining('CH 1 One → CH 2 Two → CH 3 Three → CH 1 One') });
    expect(loopFindings(A, new Map([[A, [B]]]), names)).toEqual([expect.objectContaining({ id: 'loop-coverage', severity: 'info' })]);
    expect(loopFindings(A, new Map([[A, []], [B, []], [C, []]]), names)).toEqual([]);
  });

  it('turns findings into a status, worst first', () => {
    const info = { id: 'i', severity: 'info' as const, title: '', detail: '' };
    const warning = { ...info, id: 'w', severity: 'warning' as const };
    const error = { ...info, id: 'e', severity: 'error' as const };
    expect(healthStatus([])).toBe('healthy');
    expect(healthStatus([info])).toBe('healthy');
    expect(healthStatus([info, warning])).toBe('warning');
    expect(healthStatus([warning, error])).toBe('error');
    expect(healthStatus([], 'Tunarr didn’t answer in time.')).toBe('unknown');
    expect(sortFindings([info, warning, error]).map((finding) => finding.id)).toEqual(['e', 'w', 'i']);
  });
});

type Responder = (path: string, url: URL) => Response | Promise<Response>;
function companion(responder: Responder): { config: ProxyConfig; calls: string[]; inFlight: { max: number } } {
  const calls: string[] = [];
  const inFlight = { now: 0, max: 0 };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const programming = url.pathname.endsWith('/programming');
    if (programming) { inFlight.now += 1; inFlight.max = Math.max(inFlight.max, inFlight.now); }
    try {
      if (programming) await new Promise((resolve) => setTimeout(resolve, 5));
      return await responder(url.pathname, url);
    } finally {
      if (programming) inFlight.now -= 1;
    }
  });
  const config: ProxyConfig = { ...createProxyConfig({ LINEUP_DATA_DIR: testDataDir, TUNARR_URL: 'http://tunarr:8000' }), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { config, calls, inFlight };
}

const channelList = [{ id: A, number: 1, name: 'One', groupTitle: 'News' }, { id: B, number: 2, name: 'Two' }, { id: C, number: 3, name: 'Three' }];
const sessions = { [A]: [{ state: 'started', numConnections: 2, connections: [{ ip: '10.9.8.7', userAgent: 'LivingRoomTV' }] }] };
const guideReply = {
  [A]: { id: A, number: 1, name: 'One', programs: [{ type: 'content', start: NOW - 10 * MIN, stop: NOW + 20 * MIN, id: P1, program: { type: 'movie', title: 'Alpha', year: 2001 } }, { type: 'content', start: NOW + 20 * MIN, stop: NOW + 50 * MIN, id: P2, program: { type: 'movie', title: 'Bravo' } }] },
  [B]: { id: B, number: 2, name: 'Two', programs: [] },
};

describe('Control Room summary', () => {
  it('shows now and next, viewers (counts only), guide gaps and scheduled changes', async () => {
    const { config } = companion((path) => {
      if (path === '/api/channels') return json(channelList);
      if (path === '/api/guide/channels') return json(guideReply);
      if (path === '/api/sessions') return json(sessions);
      return json({}, 404);
    });
    await config.scheduler!.store.add({ group: 'save', changes: [{ channelId: B, channelName: 'Two', label: 'Later', at: NOW + 3_600_000, action: { kind: 'restore', after: 'x' } } as never] });
    const summary = await controlRoomSummary(config, target, NOW);
    expect(summary.guide).toEqual({ status: 'ok' });
    expect(summary.channels.map((channel) => [channel.number, channel.guide, channel.viewers, channel.pendingChanges])).toEqual([[1, 'ok', 2, 0], [2, 'empty', 0, 1], [3, 'empty', 0, 0]]);
    expect(summary.channels[0]).toMatchObject({ group: 'News', now: { title: 'Alpha' }, next: { title: 'Bravo' } });
    expect(summary.channels[1].nextChangeAt).toBe(NOW + 3_600_000);
    const shown = JSON.stringify(summary);
    expect(shown).not.toContain('10.9.8.7');
    expect(shown).not.toContain('LivingRoomTV');
  });

  it('keeps going when the guide or sessions fail, and says which', async () => {
    const { config } = companion((path) => {
      if (path === '/api/channels') return json(channelList);
      if (path === '/api/guide/channels') return new Response('boom', { status: 500 });
      if (path === '/api/sessions') return json({ message: 'Route GET:/api/sessions not found', error: 'Not Found', statusCode: 404 }, 404);
      return json({}, 404);
    });
    const summary = await controlRoomSummary(config, target, NOW);
    expect(summary.guide).toEqual({ status: 'error', message: 'Tunarr returned an error (502).' });
    expect(summary.sessions).toMatchObject({ status: 'error', message: 'This Tunarr doesn’t have the route Lineup uses for it.' });
    expect(summary.channels).toHaveLength(3);
    expect(summary.channels.every((channel) => channel.guide === 'error' && channel.viewers === 0)).toBe(true);
  });

  it('doesn’t ask Tunarr for what it is known not to have', async () => {
    const { config, calls } = companion((path) => {
      if (path === '/api/channels') return json(channelList);
      if (path === '/api/sessions' || path === '/api/version') return json({ message: `Route GET:${path} not found`, error: 'Not Found', statusCode: 404 }, 404);
      if (path === '/openapi.json') return new Response('', { status: 404 });
      if (path === '/api/guide/channels') return json({});
      return json([]);
    });
    await compatibility(config);
    calls.length = 0;
    const summary = await controlRoomSummary(config, target);
    expect(summary.sessions.status).toBe('unsupported');
    expect(calls).not.toContain('/api/sessions');
  });

  it('answers the route with a 503 before Tunarr is set up, and refuses other methods', async () => {
    const unset = createProxyConfig({ LINEUP_DATA_DIR: testDataDir });
    const get = (url: string): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local' } });
    expect((await handleTunarrApi(get('/api/tunarr/control-room'), unset)).status).toBe(503);
    const { config } = companion(() => json(channelList));
    expect((await handleTunarrApi({ ...get('/api/tunarr/control-room'), method: 'DELETE' }, config)).status).toBe(405);
    expect((await handleTunarrApi(get('/api/tunarr/control-room?x=1'), config)).status).toBe(400);
    expect((await handleTunarrApi({ ...get('/api/tunarr/control-room'), headers: { host: 'lineup.local', origin: 'http://evil.example' } }, config)).status).toBe(403);
  });
});

describe('Control Room checks', () => {
  const lineups: Record<string, unknown> = {
    [A]: { lineup: [{ type: 'content', id: P1, duration: 30 * MIN }, { type: 'redirect', channel: B, duration: 5 * MIN }], programs: { [P1]: {} } },
    [B]: { lineup: [{ type: 'redirect', channel: A, duration: 5 * MIN }], programs: {} },
    [C]: { lineup: [{ type: 'content', id: P2, duration: 30 * MIN }], programs: {} },
  };
  const responder: Responder = (path) => {
    if (path === '/api/channels') return json(channelList);
    if (path === '/api/filler-lists') return json([{ id: LIST }]);
    if (path === '/api/guide/channels') return json({});
    const programming = /^\/api\/channels\/([^/]+)\/programming$/.exec(path);
    if (programming) return programming[1] === C ? new Response('', { status: 500 }) : json(lineups[programming[1]]);
    const channel = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (channel) return json({ id: channel[1], startTime: NOW, fillerCollections: [] });
    return json({}, 404);
  };

  it('validates the channel list it is given', () => {
    expect(validateCheck({ channelIds: [A, A] })).toEqual({ channelIds: [A] });
    expect('error' in validateCheck({ channelIds: [] })).toBe(true);
    expect('error' in validateCheck({ channelIds: ['../etc'] })).toBe(true);
    expect('error' in validateCheck({ channelIds: Array.from({ length: MAX_CHECK_CHANNELS + 1 }, (_, index) => `c${index}`) })).toBe(true);
    expect('error' in validateCheck(null)).toBe(true);
  });

  it('checks channels three at a time, finds a loop between them, and doesn’t let one failure stop the rest', async () => {
    const { config, inFlight } = companion(responder);
    const results = await checkChannels(config, target, [A, B, C, 'gone'], NOW);
    expect(inFlight.max).toBeLessThanOrEqual(3);
    expect(results.map((result) => [result.channelId, result.status])).toEqual([[A, 'error'], [B, 'error'], [C, 'unknown'], ['gone', 'unknown']]);
    expect(results[0].findings.map((finding) => finding.id)).toContain('redirect-loop');
    expect(results[2].error).toBe('Tunarr returned an error (502).');
    expect(results[3].error).toBe('Tunarr no longer has this channel.');
    // Kept for the summary, with when it was taken.
    const { config: same } = { config };
    const summary = await controlRoomSummary(same, target, NOW);
    expect(summary.channels.find((channel) => channel.id === A)?.diagnostic).toMatchObject({ checkedAt: NOW, status: 'error' });
  });

  it('remembers redirects from earlier checks for loops found later', async () => {
    const { config } = companion(responder);
    const first = await checkChannels(config, target, [A], NOW);
    expect(first[0].findings.map((finding) => finding.id)).toContain('loop-coverage');
    const second = await checkChannels(config, target, [B], NOW);
    expect(second[0].findings.map((finding) => finding.id)).toContain('redirect-loop');
  });

  it('goes through the route with a JSON body', async () => {
    const { config } = companion(responder);
    const response = await handleTunarrApi({ method: 'POST', url: '/api/tunarr/control-room/check', headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: [A] }) }, config);
    expect(response.status).toBe(200);
    expect(JSON.parse(text(response)).diagnostics[0]).toMatchObject({ channelId: A, mode: 'manual', items: 2 });
    const bad = await handleTunarrApi({ method: 'POST', url: '/api/tunarr/control-room/check', headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: '{"channelIds":"all"}' }, config);
    expect(bad.status).toBe(400);
  });
});

describe('Control Room in the desk', () => {
  const channel = (extra: Partial<ChannelSummary> = {}): ChannelSummary => ({ id: A, number: 1, name: 'One', group: '', viewers: 0, streams: 0, now: null, next: null, guide: 'ok', pendingChanges: 0, nextChangeAt: null, diagnostic: null, ...extra });
  const diagnostic = (status: 'healthy' | 'warning' | 'error') => ({ channelId: A, checkedAt: NOW, status, mode: 'manual' as const, items: 1, cycleMs: 1, findings: [], redirects: [] });
  const ok = { programming: { status: 'ok' as const } };

  it('never calls a channel healthy without a check, and only makes a status worse', () => {
    expect(channelStatus(channel(), ok)).toBe('unknown');
    expect(channelStatus(channel(), { programming: { status: 'unsupported', message: 'x' } })).toBe('unsupported');
    expect(channelStatus(channel({ diagnostic: diagnostic('healthy') }), ok)).toBe('healthy');
    expect(channelStatus(channel({ diagnostic: diagnostic('healthy'), guide: 'empty' }), ok)).toBe('warning');
    expect(channelStatus(channel({ diagnostic: diagnostic('error'), guide: 'empty' }), ok)).toBe('error');
    expect(channelStatus(channel({ diagnostic: diagnostic('healthy') }), ok, { ok: false, message: 'down', at: NOW })).toBe('error');
    expect(summaryNotes(channel({ guide: 'empty' }), { ok: true, message: '', at: NOW })).toHaveLength(2);
  });

  it('filters and counts', () => {
    const rows = [
      { channel: channel({ viewers: 3 }), status: 'error' as const },
      { channel: channel({ pendingChanges: 1 }), status: 'warning' as const },
      { channel: channel(), status: 'healthy' as const },
    ];
    expect(filterCounts(rows)).toEqual({ all: 3, errors: 1, warnings: 1, viewers: 1, scheduled: 1 });
    expect(matchesFilter('viewers', channel({ streams: 1 }), 'unknown')).toBe(true);
    expect(nextFilter('scheduled')).toBe('all');
  });

  it('moves like a remote: steps, pages and ends', () => {
    expect(stepRow(0, 20, 'ArrowUp')).toBe(0);
    expect(stepRow(0, 20, 'PageDown')).toBe(8);
    expect(stepRow(19, 20, 'ChannelDown')).toBe(19);
    expect(stepRow(5, 20, 'Home')).toBe(0);
    expect(stepRow(5, 20, 'End')).toBe(19);
    expect(stepRow(0, 0, 'ArrowDown')).toBe(0);
    expect(checkBatches(Array.from({ length: 60 }, (_, index) => String(index))).map((batch) => batch.length)).toEqual([25, 25, 10]);
  });
});

describe('stream check', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads only the playlist and reports what went wrong', async () => {
    const fetchMock = vi.fn(async () => new Response('#EXTM3U\n#EXT-X-VERSION:6\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkStream('/api/tunarr/channels/x/stream.m3u8', undefined, 1000, () => NOW)).toEqual({ ok: true, message: 'Playlist answered.', at: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'stream_unexpected', message: 'Tunarr’s stream playlist points somewhere Lineup doesn’t pass on.' } }, 502)));
    expect(await checkStream('/x', undefined, 1000)).toMatchObject({ ok: false, message: expect.stringContaining('points somewhere') });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    expect(await checkStream('/x', undefined, 1000)).toMatchObject({ ok: false, message: 'the reply wasn’t an HLS playlist.' });
  });

  it('gives up after its time limit and can be cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    expect(await checkStream('/x', undefined, 20)).toMatchObject({ ok: false, message: 'no answer within 0 seconds.' });
    const controller = new AbortController();
    const pending = checkStream('/x', controller.signal, 10_000);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, message: 'cancelled.' });
  });
});
