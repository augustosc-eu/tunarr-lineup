import { describe, expect, it, vi } from 'vitest';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';
import { guideEntry, rewritePlaylist, slimGuide, validateGuideRange, viewerCounts } from '../server/watch';
import { testDataDir } from './tempData';

const CHANNEL = '960f0f1e-6b20-4422-9af3-91b5705a3933';
const OTHER = '03211527-b3eb-4a63-87fb-0bbebd9ecaa5';
const target = { origin: 'http://tunarr:8000', basePath: '', host: 'tunarr:8000' };

function setup(responder: (url: string) => Response) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    return responder(String(input));
  });
  const config: ProxyConfig = { ...createProxyConfig({ LINEUP_DATA_DIR: testDataDir, TUNARR_URL: 'http://tunarr:8000' }), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { calls, config };
}
const get = (url: string, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local:3000', ...headers } });
const text = (response: { body: string | Uint8Array }) => (typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

describe('guide grid data', () => {
  it('titles episodes by show with season and episode, and keeps only what the grid shows', () => {
    const entry = guideEntry({
      type: 'content', start: 1000, stop: 2000, id: 'p1', isPaused: false,
      program: { type: 'episode', title: 'Pilot', seasonNumber: 1, episodeNumber: 2, show: { title: 'Bravo' }, actors: [{ name: 'Someone' }], summary: 'long text' },
    });
    expect(entry).toEqual({ start: 1000, stop: 2000, type: 'content', title: 'Bravo', detail: 'S01 E02 · Pilot', id: 'p1' });
  });

  it('labels redirects and flex, and drops entries without times', () => {
    expect(guideEntry({ type: 'redirect', start: 0, stop: 10, channel: OTHER, channelName: 'News', channelNumber: 3 })).toMatchObject({ title: 'News', detail: 'Redirect to CH 3', redirectTo: OTHER });
    expect(guideEntry({ type: 'flex', start: 0, stop: 10 })).toMatchObject({ title: 'Flex time' });
    expect(guideEntry({ type: 'content', start: 10, stop: 10 })).toBeNull();
  });

  it('turns Tunarr’s channel map into channels sorted by number', () => {
    const slim = slimGuide({
      [OTHER]: { id: OTHER, number: 2, name: 'Two', programs: [{ type: 'content', start: 5, stop: 9, program: { type: 'movie', title: 'M', year: 1999 } }] },
      [CHANNEL]: { id: CHANNEL, number: 1, name: 'One', icon: { path: 'x' }, programs: [] },
    });
    expect(slim.map((channel) => channel.number)).toEqual([1, 2]);
    expect(slim[1].programs[0]).toMatchObject({ title: 'M', detail: '1999' });
  });

  it('limits the grid to a day and to from/to', () => {
    expect('error' in validateGuideRange(new URLSearchParams({ from: '2026-10-19T00:00:00Z', to: '2026-10-21T00:00:00Z' }))).toBe(true);
    expect('error' in validateGuideRange(new URLSearchParams({ from: '2026-10-19T00:00:00Z', to: '2026-10-19T03:00:00Z', x: '1' }))).toBe(true);
    expect(validateGuideRange(new URLSearchParams({ from: '2026-10-19T00:00:00Z', to: '2026-10-19T03:00:00Z' }))).toEqual({ from: '2026-10-19T00:00:00.000Z', to: '2026-10-19T03:00:00.000Z' });
  });

  it('serves the slim guide through /api/tunarr/guide', async () => {
    const { calls, config } = setup(() => jsonResponse({ [CHANNEL]: { id: CHANNEL, number: 1, name: 'One', programs: [] } }));
    const response = await handleTunarrApi(get('/api/tunarr/guide?from=2026-10-19T10:00:00.000Z&to=2026-10-19T13:00:00.000Z'), config);
    expect(response.status).toBe(200);
    expect(JSON.parse(text(response)).channels).toEqual([{ id: CHANNEL, number: 1, name: 'One', programs: [] }]);
    expect(calls[0]).toBe('http://tunarr:8000/api/guide/channels?dateFrom=2026-10-19T10%3A00%3A00.000Z&dateTo=2026-10-19T13%3A00%3A00.000Z');
  });
});

describe('viewers', () => {
  it('counts viewers per channel and never passes on who they are', () => {
    const counts = viewerCounts({
      [CHANNEL]: [{ type: 'hls', state: 'started', numConnections: 2, connections: [{ ip: '192.168.1.20', userAgent: 'TV' }, { ip: '10.0.0.4' }] }],
      [OTHER]: [{ type: 'hls', state: 'stopped', numConnections: 0, connections: [] }],
      '../evil': [{ state: 'started', numConnections: 1 }],
    }, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    expect(counts).toEqual({ [CHANNEL]: { viewers: 2, streams: 1 } });
  });

  it('serves counts through /api/tunarr/sessions without IPs', async () => {
    const { config } = setup(() => jsonResponse({ [CHANNEL]: [{ type: 'hls', state: 'started', numConnections: 1, connections: [{ ip: '192.168.1.20', userAgent: 'curl' }] }] }));
    const response = await handleTunarrApi(get('/api/tunarr/sessions'), config);
    expect(text(response)).not.toContain('192.168');
    expect(JSON.parse(text(response))).toEqual({ [CHANNEL]: { viewers: 1, streams: 1 } });
  });
});

describe('live stream', () => {
  const master = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=2411200,RESOLUTION=1920x1080\n/stream/channels/${CHANNEL}/hls/stream.m3u8\n`;
  const variant = `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.004000,\n/stream/channels/${CHANNEL}/hls/data000000.ts\n#EXTINF:4.0,\ndata000001.ts\n`;

  it('points every playlist address back at the companion', () => {
    const base = new URL(`http://tunarr:8000/stream/channels/${CHANNEL}/hls/stream.m3u8`);
    expect(rewritePlaylist(variant, base, target, CHANNEL)).toBe(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.004000,\n/api/tunarr/channels/${CHANNEL}/hls/data000000.ts\n#EXTINF:4.0,\n/api/tunarr/channels/${CHANNEL}/hls/data000001.ts\n`);
  });

  it('refuses a playlist that points at another host, channel or path', () => {
    const base = new URL(`http://tunarr:8000/stream/channels/${CHANNEL}.m3u8`);
    expect(rewritePlaylist('#EXTM3U\nhttp://evil.example/x.ts\n', base, target, CHANNEL)).toBeNull();
    expect(rewritePlaylist(`#EXTM3U\n/stream/channels/${OTHER}/hls/data1.ts\n`, base, target, CHANNEL)).toBeNull();
    expect(rewritePlaylist('#EXTM3U\n/api/settings\n', base, target, CHANNEL)).toBeNull();
    expect(rewritePlaylist(`#EXTM3U\n#EXT-X-MAP:URI="http://evil.example/init.mp4"\n`, base, target, CHANNEL)).toBeNull();
    expect(rewritePlaylist(`#EXTM3U\n/stream/channels/${CHANNEL}/hls/..%2f..%2fetc.ts\n`, base, target, CHANNEL)).toBeNull();
  });

  it('asks Tunarr for HLS and rewrites the master playlist', async () => {
    const { calls, config } = setup(() => new Response(master, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
    const response = await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/stream.m3u8`), config);
    expect(response.status).toBe(200);
    expect(calls[0]).toBe(`http://tunarr:8000/stream/channels/${CHANNEL}.m3u8?mode=hls`);
    expect(text(response)).toContain(`/api/tunarr/channels/${CHANNEL}/hls/stream.m3u8`);
    expect(text(response)).not.toContain('tunarr:8000');
    expect(response.headers['content-type']).toBe('application/vnd.apple.mpegurl');
  });

  it('passes segments through as bytes, only of video types', async () => {
    const segment = new Uint8Array([0x47, 1, 2, 3]);
    const { calls, config } = setup((url) => (url.endsWith('.ts') ? new Response(segment, { status: 200, headers: { 'content-type': 'video/mp2t' } }) : new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const ok = await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/hls/data000001.ts`), config);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(segment);
    expect(calls[0]).toBe(`http://tunarr:8000/stream/channels/${CHANNEL}/hls/data000001.ts`);
    const html = await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/hls/data000002.mp4`), config);
    expect(html.status).toBe(502);
  });

  it('validates stream file names, methods, queries and Origin before calling Tunarr', async () => {
    const { calls, config } = setup(() => jsonResponse({}));
    expect((await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/hls/..%2Fsecret.ts`), config)).status).toBe(400);
    expect((await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/hls/x.php`), config)).status).toBe(400);
    expect((await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/stream.m3u8?mode=mpegts`), config)).status).toBe(400);
    expect((await handleTunarrApi({ ...get(`/api/tunarr/channels/${CHANNEL}/stream.m3u8`), method: 'POST' }, config)).status).toBe(405);
    expect((await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/stream.m3u8`, { origin: 'http://evil.example' }), config)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('redirect graph', () => {
  it('lists every redirect between channels, from lineups and slots', async () => {
    const { config } = setup((url) => {
      if (url.endsWith('/api/channels')) return jsonResponse([{ id: 'a', number: 1, name: 'A' }, { id: 'b', number: 2, name: 'B' }]);
      if (url.includes('/channels/a/')) return jsonResponse({ lineup: [{ type: 'redirect', channel: 'b', duration: 10 }] });
      return jsonResponse({ lineup: [], schedule: { slots: [{ type: 'redirect', channelId: 'a' }] } });
    });
    const response = await handleTunarrApi(get('/api/tunarr/redirects'), config);
    expect(JSON.parse(text(response))).toEqual({ edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  });
});
