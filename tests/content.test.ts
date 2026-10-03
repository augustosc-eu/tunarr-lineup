import { describe, expect, it } from 'vitest';
import { buildLibrarySearch, sanitizeMediaSources, validateChannelSettings, validateCustomShowBody, validateFillerListBody } from '../server/content';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

const UUID_A = '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a';
const UUID_B = '1e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7b';
const SOURCE = 'fb9b2110-d086-49b3-997c-9873de64ef75';

type Call = { url: string; method: string; body?: unknown };

function harness(reply: (url: string, method: string) => unknown) {
  const calls: Call[] = [];
  const config: ProxyConfig = {
    ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000' }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('http://tunarr:8000', '');
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const data = reply(url, method);
      return data === undefined ? new Response(null, { status: 204 }) : Response.json(data);
    }) as typeof fetch,
  };
  return { calls, config };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): ProxyRequest => ({
  method,
  url: `/api/tunarr${path}`,
  headers: { host: 'lineup.local', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const text = (response: { body: string | Uint8Array }) => (typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const parse = (response: { body: string | Uint8Array }) => JSON.parse(text(response));

describe('library browsing', () => {
  it('never passes media-server addresses or accounts to the browser', async () => {
    const { config } = harness(() => [{
      id: SOURCE, name: 'Baga-Plex', type: 'plex', uri: 'http://10.0.0.5:32400', username: 'owner', userId: '42', clientIdentifier: 'secret',
      libraries: [{ id: UUID_A, name: 'Movies', mediaType: 'movies', enabled: true, externalKey: '1' }, { id: UUID_B, name: 'Off', mediaType: 'shows', enabled: false }],
    }]);
    const response = await handleTunarrApi(req('GET', '/media-sources'), config);
    expect(parse(response)).toEqual([{ id: SOURCE, name: 'Baga-Plex', type: 'plex', libraries: [{ id: UUID_A, name: 'Movies', mediaType: 'movies' }] }]);
    expect(text(response)).not.toMatch(/10\.0\.0\.5|owner|secret/);
    expect(sanitizeMediaSources('nope')).toEqual([]);
  });

  it('builds Tunarr search requests from a small validated query', () => {
    const built = buildLibrarySearch({ mediaSourceId: SOURCE, libraryId: UUID_A, text: ' office ', type: 'season', parentId: UUID_B, page: 2, limit: 20 });
    expect(built).toEqual({ request: {
      mediaSourceId: SOURCE, libraryId: UUID_A, page: 3, limit: 20,
      query: { query: 'office', filter: { type: 'op', op: 'and', children: [
        { type: 'value', fieldSpec: { key: 'type', name: 'Type', op: '=', type: 'string', value: ['season'] } },
        { type: 'value', fieldSpec: { key: 'parent.id', name: '', op: '=', type: 'string', value: [UUID_B] } },
      ] } },
    } });
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, type: 'show' })).toMatchObject({ request: { page: 0, limit: 40, query: { filter: { fieldSpec: { key: 'type', value: ['show'] } } } } });
    // Free-text searches are paged from 1 by Tunarr; listings from 0.
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, text: 'harry', page: 0 })).toMatchObject({ request: { page: 1 } });
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, page: 0 })).toMatchObject({ request: { page: 0 } });
    expect(buildLibrarySearch({ mediaSourceId: 'x' })).toHaveProperty('error');
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, type: 'channel' })).toHaveProperty('error');
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, limit: 500 })).toHaveProperty('error');
    expect(buildLibrarySearch({ mediaSourceId: SOURCE, filter: { raw: true } })).not.toHaveProperty('request.query.raw');
  });

  it('proxies search and descendants', async () => {
    const { calls, config } = harness((url) => (url.includes('descendants') ? [{ type: 'content', id: UUID_A, duration: 1, program: {} }] : { results: [], page: 0, totalPages: 0, totalHits: 0 }));
    expect((await handleTunarrApi(req('POST', '/library/search', { mediaSourceId: SOURCE, text: 'harry' }), config)).status).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/programs/search' });
    expect(parse(await handleTunarrApi(req('GET', `/programs/${UUID_A}/descendants`), config))).toHaveLength(1);
    expect((await handleTunarrApi(req('GET', '/programs/..%2f/descendants'), config)).status).toBe(400);
    expect((await handleTunarrApi(req('GET', '/programs/not-a-uuid/descendants'), config)).status).toBe(400);
  });
});

describe('filler lists and custom shows', () => {
  const content = { type: 'content', id: UUID_A, duration: 30000, program: { title: 'Ad' } };

  it('validates list bodies', () => {
    expect(validateFillerListBody({ name: 'Ads', programs: [content] }, true)).toEqual({ body: { name: 'Ads', programs: [content] } });
    expect(validateFillerListBody({ name: 'Ads', programs: [] }, true)).toEqual({ error: 'A filler list needs at least one program.' });
    expect(validateFillerListBody({ name: '', programs: [content] }, true)).toHaveProperty('error');
    expect(validateFillerListBody({ programs: [{ ...content, program: undefined }] }, false)).toHaveProperty('error');
    expect(validateFillerListBody({ name: 'Renamed' }, false)).toEqual({ body: { name: 'Renamed' } });
    expect(validateCustomShowBody({ name: 'Marathon', programs: [content] }, true)).toEqual({ body: { name: 'Marathon', programs: [{ type: 'content', id: UUID_A, duration: 30000 }] } });
    expect(validateCustomShowBody({ programs: [{ type: 'flex', id: UUID_A, duration: 1 }] }, false)).toHaveProperty('error');
  });

  it('creates, updates and deletes lists', async () => {
    const { calls, config } = harness((url, method) => (method === 'GET' ? [{ id: UUID_A, name: 'Ads', contentCount: 3, extra: 'dropped' }] : method === 'DELETE' ? undefined : { id: UUID_A }));
    expect(parse(await handleTunarrApi(req('GET', '/filler-lists'), config))).toEqual([{ id: UUID_A, name: 'Ads', contentCount: 3, synced: false }]);
    expect((await handleTunarrApi(req('POST', '/filler-lists', { name: 'Ads', programs: [content] }), config)).status).toBe(201);
    expect((await handleTunarrApi(req('PUT', `/filler-lists/${UUID_A}`, { name: 'Bumpers' }), config)).status).toBe(200);
    expect((await handleTunarrApi(req('DELETE', `/filler-lists/${UUID_A}`), config)).status).toBe(200);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/filler-lists', 'POST /api/filler-lists', `PUT /api/filler-lists/${UUID_A}`, `DELETE /api/filler-lists/${UUID_A}`]);
    expect((await handleTunarrApi(req('POST', `/filler-lists/${UUID_A}`, {}), config)).status).toBe(405);
    expect((await handleTunarrApi(req('DELETE', `/filler-lists/${UUID_A}`, undefined, { origin: 'https://evil.example' }), config)).status).toBe(403);
    expect((await handleTunarrApi(req('GET', '/filler-lists?all=1'), config)).status).toBe(400);
  });

  it('keeps a custom show’s playlist sync when its programs are edited', async () => {
    const { calls, config } = harness((url, method) => (method === 'GET' ? { id: UUID_A, name: 'Synced', syncMediaSourceId: SOURCE, syncMediaSourceType: 'plex', syncExternalPlaylistId: 'pl-1' } : { id: UUID_A }));
    await handleTunarrApi(req('PUT', `/custom-shows/${UUID_A}`, { programs: [content] }), config);
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      programs: [{ type: 'content', id: UUID_A, duration: 30000 }], enableSync: true, syncMediaSourceId: SOURCE, syncMediaSourceType: 'plex', syncExternalPlaylistId: 'pl-1',
    });
  });
});

describe('channel settings', () => {
  const channel = {
    id: 'chan-1', name: 'Movies', number: 4, duration: 1000, startTime: 0, guideFlexTitle: '', guideMinimumDuration: 30000,
    fillerCollections: [], fillerRepeatCooldown: 30000, disableFillerOverlay: false, groupTitle: 'tunarr',
    transcodeConfigId: UUID_B, streamMode: 'hls', programCount: 7, sessions: [], icon: { path: '' }, offline: { mode: 'pic' },
  };

  it('validates the fields Lineup may change', () => {
    expect(validateChannelSettings({ fillerCollections: [{ id: UUID_A, weight: 50, cooldownSeconds: 600 }], fillerRepeatCooldown: 60000 })).toEqual({ changes: { fillerCollections: [{ id: UUID_A, weight: 50, cooldownSeconds: 600 }], fillerRepeatCooldown: 60000 } });
    expect(validateChannelSettings({ transcodeConfigId: UUID_A })).toEqual({ error: '"transcodeConfigId" can\'t be changed here.' });
    expect(validateChannelSettings({ number: 0 })).toHaveProperty('error');
    expect(validateChannelSettings({ fillerCollections: [{ id: 'x', weight: 1, cooldownSeconds: 0 }] })).toHaveProperty('error');
  });

  it('merges changes onto the current channel and leaves everything else alone', async () => {
    let stored: Record<string, unknown> = { ...channel };
    const { calls, config } = harness((url, method) => {
      if (method === 'PUT') stored = { ...stored, ...(calls.at(-1)!.body as object) };
      return stored;
    });
    const response = await handleTunarrApi(req('PUT', '/channels/chan-1/settings', { name: 'Movie Night', fillerCollections: [{ id: UUID_A, weight: 1, cooldownSeconds: 0 }] }), config);
    expect(response.status).toBe(200);
    const put = calls.find((call) => call.method === 'PUT')!.body as Record<string, unknown>;
    expect(put).toMatchObject({ name: 'Movie Night', number: 4, transcodeConfigId: UUID_B, streamMode: 'hls', icon: { path: '' } });
    expect('programCount' in put || 'sessions' in put).toBe(false);
    expect(parse(response)).toMatchObject({ name: 'Movie Night', fillerCollections: [{ id: UUID_A, weight: 1, cooldownSeconds: 0 }] });
    expect('transcodeConfigId' in parse(response)).toBe(false);
  });
});
