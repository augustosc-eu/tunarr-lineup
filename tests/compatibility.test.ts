import { describe, expect, it, vi } from 'vitest';
import { CAPABILITY_MATRIX, checkVersion, cleanVersion, compatibility, decide, describedOperations, detectCompatibility, unavailableReason, type CapabilityId, type ProbeResult } from '../server/compatibility';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';
import { callTunarr, routeMissing } from '../server/upstream';
import { blockedCapabilities, blockedReason, diagnosticsFile, partBlocked, versionLine } from '../lib/compatibility';
import { testDataDir } from './tempData';

const CHANNEL = '960f0f1e-6b20-4422-9af3-91b5705a3933';
const BIG = '03211527-b3eb-4a63-87fb-0bbebd9ecaa5';
const SOURCE = '3c3c3c3c-1a2b-4c3d-8e9f-000000000001';
const LIBRARY = '3c3c3c3c-1a2b-4c3d-8e9f-000000000002';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const routeNotFound = (method: string, path: string) => json({ message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 }, 404);

/** Every route Lineup's matrix asks about, as Tunarr's OpenAPI document lists them. */
const ALL_PATHS: Record<string, Record<string, unknown>> = {
  '/api/channels': { get: {}, post: {} },
  '/api/channels/{id}': { get: {}, put: {}, delete: {} },
  '/api/channels/{id}/programming': { get: {}, post: {} },
  '/api/channels/{channelId}/schedule-slots': { post: {} },
  '/api/channels/{channelId}/schedule-time-slots': { post: {} },
  '/api/guide/channels': { get: {} },
  '/api/sessions': { get: {} },
  '/api/filler-lists': { get: {}, post: {} },
  '/api/filler-lists/{id}': { get: {}, put: {}, delete: {} },
  '/api/filler-lists/{id}/programs': { get: {} },
  '/api/custom-shows': { get: {}, post: {} },
  '/api/custom-shows/{id}': { get: {}, put: {}, delete: {} },
  '/api/custom-shows/{id}/programs': { get: {} },
  '/api/smart_collections': { get: {}, post: {} },
  '/api/smart_collections/{id}': { get: {}, put: {}, delete: {} },
  '/api/media-sources': { get: {}, post: {} },
  '/api/media-sources/{id}': { delete: {} },
  '/api/media-sources/{id}/libraries/refresh': { post: {} },
  '/api/media-sources/{id}/libraries/{libraryId}': { put: {} },
  '/api/media-sources/{id}/libraries/{libraryId}/scan': { post: {} },
  '/api/jellyfin/login': { post: {} },
  '/api/emby/login': { post: {} },
  '/api/programs/search': { post: {} },
  '/api/programs/{id}': { get: {} },
  '/api/programs/{id}/descendants': { get: {} },
  '/api/transcode_configs': { get: {} },
  '/api/transcode_configs/{id}': { get: {}, put: {}, delete: {} },
  '/api/transcode_configs/{id}/copy': { post: {} },
};
/** The API description without some operations ("post /api/filler-lists"). */
const without = (...ops: string[]) => {
  const paths: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(ALL_PATHS));
  for (const op of ops) {
    const [method, path] = op.split(' ');
    const key = Object.keys(paths).find((route) => route.replace(/\{[^}]*\}/g, '{}') === path)!;
    delete paths[key][method];
  }
  return paths;
};

/** `null` means Tunarr doesn't have that route. */
type Fake = { version?: unknown; openapi?: unknown; overrides?: Record<string, () => Response> };

/** A read-only Tunarr: answers the checks, and records every request made. */
function fakeTunarr({ version = { tunarr: '1.3.13', ffmpeg: '7.1 secret-build', nodejs: 'v22' }, openapi = { info: { version: '1.3.13' }, paths: ALL_PATHS }, overrides = {} }: Fake = {}) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, url: url.pathname + url.search, body: init?.body as string | undefined });
    const override = overrides[url.pathname];
    if (override) return override();
    switch (url.pathname) {
      case '/api/version': return version === null ? routeNotFound('GET', '/api/version') : json(version);
      case '/openapi.json': return openapi === null ? new Response('', { status: 404 }) : json(openapi);
      case '/api/channels': return json([{ id: BIG, number: 1, name: 'Big', programCount: 9000 }, { id: CHANNEL, number: 2, name: 'Small', programCount: 3 }]);
      case `/api/channels/${CHANNEL}`: return json({ id: CHANNEL, number: 2, name: 'Small', fillerCollections: [] });
      case `/api/channels/${CHANNEL}/programming`: return json({ lineup: [], programs: {} });
      case '/api/guide/channels': return json({});
      case '/api/sessions': return json({});
      case '/api/filler-lists': case '/api/custom-shows': case '/api/smart_collections': case '/api/transcode_configs': return json([]);
      case '/api/media-sources': return json([{ id: SOURCE, name: 'Plex', uri: 'http://10.0.0.9:32400', accessToken: 'plex-token', libraries: [{ id: LIBRARY, name: 'Movies', enabled: true }] }]);
      case '/api/programs/search': return json({ results: [], totalHits: 0 });
      default: return routeNotFound(method, url.pathname);
    }
  });
  return { calls, fetchImpl };
}

function configFor(fake: ReturnType<typeof fakeTunarr>, url = 'http://admin:s3cret@secret-host.lan:8000'): ProxyConfig {
  return { ...createProxyConfig({ LINEUP_DATA_DIR: testDataDir, TUNARR_URL: url }), fetchImpl: fake.fetchImpl as unknown as typeof fetch };
}
const target = { origin: 'http://secret-host.lan:8000', basePath: '', host: 'secret-host.lan:8000', authorization: 'Basic c2VjcmV0' };
const statusOf = (report: { capabilities: Array<{ id: CapabilityId; status: string }> }, id: CapabilityId) => report.capabilities.find((item) => item.id === id)?.status;
const get = (url: string): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local:3000' } });
const post = (url: string): ProxyRequest => ({ method: 'POST', url, headers: { host: 'lineup.local:3000', 'content-type': 'application/json' }, body: '{}' });
const text = (response: { body: string | Uint8Array }) => (typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

describe('compatibility decisions', () => {
  const spec = (id: CapabilityId) => CAPABILITY_MATRIX.find((item) => item.id === id)!;
  const ok: ProbeResult = { ok: true, data: [] };
  const allOps = describedOperations({ paths: ALL_PATHS });

  it('trusts a read that worked, even when the API description omits the route', () => {
    expect(decide(spec('guide'), { ops: new Set(), liveStreams: 0, probes: { guide: ok } }).status).toBe('available');
  });

  it('calls a route Tunarr says it lacks unavailable, and a reply of the wrong shape degraded', () => {
    expect(decide(spec('sessions'), { ops: allOps, liveStreams: 0, probes: { sessions: { ok: false, kind: 'missing', reason: 'gone' } } })).toEqual({ status: 'unavailable', reason: 'gone' });
    expect(decide(spec('sessions'), { ops: allOps, liveStreams: 0, probes: { sessions: { ok: false, kind: 'shape', reason: 'Tunarr answered, but odd.' } } }).status).toBe('degraded');
  });

  it('keeps a check that failed for a passing reason usable (degraded), never unavailable', () => {
    for (const reason of ['Tunarr didn’t answer in time.', 'Tunarr returned an error (500).']) {
      const decided = decide(spec('guide'), { ops: allOps, liveStreams: 0, probes: { guide: { ok: false, kind: 'failed', reason } } });
      expect(decided).toMatchObject({ status: 'degraded', reason: expect.stringContaining('stays on') });
      expect(blockedReason({ checkedAt: 0, configured: true, connected: true, version: checkVersion(null, 'none'), apiDescription: 'read', capabilities: [{ id: 'guide', label: 'Guide', uses: '', ...decided }] }, 'guide')).toBeNull();
    }
    // The description failing to load (not missing) leaves writes on too.
    expect(decide(spec('manual-saves'), { ops: null, description: 'failed', liveStreams: 0, probes: {} }).status).toBe('degraded');
  });

  it('decides writes from the API description only, never by trying them', () => {
    expect(decide(spec('manual-saves'), { ops: allOps, liveStreams: 0, probes: {} }).status).toBe('available');
    const without = new Set([...allOps!].filter((op) => op !== 'post /api/channels/{}/programming'));
    expect(decide(spec('manual-saves'), { ops: without, liveStreams: 0, probes: {} })).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('POST /api/channels/:id/programming') });
    expect(decide(spec('manual-saves'), { ops: null, liveStreams: 0, probes: {} }).status).toBe('untested');
  });

  it('turns off a readable capability whose required write route Tunarr’s API doesn’t list, saying which', () => {
    const noPut = new Set([...allOps!].filter((op) => op !== 'put /api/channels/{}'));
    const decided = decide(spec('channel-settings'), { ops: noPut, liveStreams: 0, probes: { channel: ok } });
    expect(decided).toEqual({ status: 'unavailable', reason: 'Reading works, but this Tunarr’s API doesn’t list PUT /api/channels/:id, which channel settings needs, so it’s turned off instead of failing when used.' });
    // With every required route listed (or read), it's available.
    expect(decide(spec('channel-settings'), { ops: allOps, liveStreams: 0, probes: { channel: ok } }).status).toBe('available');
    // A GET the description omits but that answered exists all the same.
    const noGet = new Set([...allOps!].filter((op) => op !== 'get /api/channels/{}'));
    expect(decide(spec('channel-settings'), { ops: noGet, liveStreams: 0, probes: { channel: ok } }).status).toBe('available');
    // Definitely absent beats a check that merely timed out.
    expect(decide(spec('channel-settings'), { ops: noPut, liveStreams: 0, probes: { channel: { ok: false, kind: 'failed', reason: 'Tunarr didn’t answer in time.' } } }).status).toBe('unavailable');
  });

  it('declares required routes and parts: a part missing degrades only that part', () => {
    for (const row of CAPABILITY_MATRIX) for (const { label, ops } of row.parts ?? []) expect([row.id, label.length > 0, ops.length > 0]).toEqual([row.id, true, true]);
    expect(spec('library-search').parts?.map(({ id, ops }) => [id, ops])).toEqual([['lookup', [['get', '/api/programs/{}']]], ['browse', [['get', '/api/programs/{}/descendants']]]]);
    const noLookup = new Set([...allOps!].filter((op) => op !== 'get /api/programs/{}'));
    expect(decide(spec('library-search'), { ops: noLookup, liveStreams: 0, probes: { search: ok } })).toMatchObject({ status: 'degraded', reason: expect.stringContaining('media repair replacements') });
    // Both slot routes are required: the editor saves either kind.
    expect(spec('slot-schedules').ops).toHaveLength(2);
    const noTime = new Set([...allOps!].filter((op) => op !== 'post /api/channels/{}/schedule-time-slots'));
    expect(decide(spec('slot-schedules'), { ops: noTime, liveStreams: 0, probes: {} }).status).toBe('unavailable');
  });

  it('never reports a manager whole when the API lists its reads but not its writes', () => {
    const readOnly = describedOperations({ paths: without('post /api/filler-lists', 'put /api/filler-lists/{}', 'delete /api/filler-lists/{}') });
    const decided = decide(spec('filler-lists'), { ops: readOnly, liveStreams: 0, probes: { fillerLists: ok } });
    expect(decided.status).toBe('degraded');
    expect(decided.reason).toContain('POST /api/filler-lists, PUT /api/filler-lists/:id and DELETE /api/filler-lists/:id');
    expect(decided.reason).toContain('creating filler lists (also from a library folder), changing a list’s name or programs and deleting filler lists won’t work');
    expect(decided.parts?.map(({ id, status }) => [id, status])).toEqual([['contents', 'available'], ['create', 'unavailable'], ['edit', 'unavailable'], ['delete', 'unavailable']]);
    const report = { checkedAt: 0, configured: true, connected: true, version: checkVersion(null, 'none'), apiDescription: 'read' as const, capabilities: [{ id: 'filler-lists' as const, label: 'Filler lists', uses: '', ...decided }] };
    // Reading stays on; each missing write is refused on its own, with why.
    expect(blockedReason(report, 'filler-lists')).toBeNull();
    expect(partBlocked(report, 'filler-lists', 'create')).toBe('This Tunarr’s API doesn’t offer creating filler lists (also from a library folder), so it’s turned off here.');
    expect(partBlocked(report, 'filler-lists', 'contents')).toBeNull();
    expect(unavailableReason(report, 'filler-lists', 'delete')).toContain('deleting filler lists');
    expect(unavailableReason(report, 'filler-lists')).toBeNull();
  });

  it('detects a missing DELETE on its own, for every manager', () => {
    for (const [id, op, probe] of [
      ['filler-lists', 'delete /api/filler-lists/{}', 'fillerLists'],
      ['custom-shows', 'delete /api/custom-shows/{}', 'customShows'],
      ['smart-collections', 'delete /api/smart_collections/{}', 'smartCollections'],
      ['media-sources', 'delete /api/media-sources/{}', 'mediaSources'],
      ['transcode-profiles', 'delete /api/transcode_configs/{}', 'transcodeConfigs'],
    ] as const) {
      const decided = decide(spec(id), { ops: describedOperations({ paths: without(op) }), liveStreams: 0, probes: { [probe]: ok } });
      expect([id, decided.status, decided.parts?.filter((part) => part.status === 'unavailable').map((part) => part.id)]).toEqual([id, 'degraded', ['delete']]);
      expect(decided.reason).toContain(`DELETE ${op.split(' ')[1].replace('{}', ':id')}`);
    }
    // Every write each manager makes is listed: creation, editing, copying, refreshing, enabling and scanning too.
    const writes = CAPABILITY_MATRIX.flatMap((row) => (row.parts ?? []).flatMap((part) => part.ops)).filter(([method]) => method !== 'get').map(([method, path]) => `${method} ${path}`);
    expect(writes).toEqual(expect.arrayContaining([
      'post /api/channels', 'delete /api/channels/{}',
      'post /api/filler-lists', 'put /api/filler-lists/{}', 'delete /api/filler-lists/{}',
      'post /api/custom-shows', 'put /api/custom-shows/{}', 'delete /api/custom-shows/{}',
      'post /api/smart_collections', 'put /api/smart_collections/{}', 'delete /api/smart_collections/{}',
      'post /api/media-sources', 'delete /api/media-sources/{}', 'post /api/media-sources/{}/libraries/refresh', 'put /api/media-sources/{}/libraries/{}', 'post /api/media-sources/{}/libraries/{}/scan', 'post /api/jellyfin/login', 'post /api/emby/login',
      'put /api/transcode_configs/{}', 'post /api/transcode_configs/{}/copy', 'delete /api/transcode_configs/{}',
    ]));
  });

  it('turns channel creation off only when none of it is listed', () => {
    expect(decide(spec('channel-admin'), { ops: allOps, liveStreams: 0, probes: {} }).status).toBe('available');
    expect(decide(spec('channel-admin'), { ops: describedOperations({ paths: without('delete /api/channels/{}') }), liveStreams: 0, probes: {} })).toMatchObject({ status: 'degraded', reason: expect.stringContaining('deleting channels won’t work') });
    expect(decide(spec('channel-admin'), { ops: describedOperations({ paths: without('delete /api/channels/{}', 'post /api/channels') }), liveStreams: 0, probes: {} })).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('POST /api/channels and DELETE /api/channels/:id') });
    expect(decide(spec('channel-admin'), { ops: null, description: 'missing', liveStreams: 0, probes: {} }).status).toBe('untested');
  });

  it('decides creating an empty channel and duplicating one from every route each needs', () => {
    const parts = (...missing: string[]) => Object.fromEntries((decide(spec('channel-admin'), { ops: describedOperations({ paths: without(...missing) }), liveStreams: 0, probes: {} }).parts ?? []).map((part) => [part.id, part.status]));
    expect(parts()).toEqual({ create: 'available', copy: 'available', delete: 'available' });
    // A copy is POSTed, then read and saved with its name and number: without either, it would be left half made.
    expect(parts('get /api/channels/{}')).toEqual({ create: 'available', copy: 'unavailable', delete: 'available' });
    expect(parts('put /api/channels/{}')).toEqual({ create: 'available', copy: 'unavailable', delete: 'available' });
    // An empty channel needs the transcode profiles (for the default one).
    expect(parts('get /api/transcode_configs')).toEqual({ create: 'unavailable', copy: 'available', delete: 'available' });
    expect(parts('post /api/channels')).toEqual({ create: 'unavailable', copy: 'unavailable', delete: 'available' });
    const report = { capabilities: [{ id: 'channel-admin', label: 'Creating and deleting channels', status: 'degraded', reason: '', uses: '', parts: [{ id: 'create', label: 'creating empty channels', status: 'available' }, { id: 'copy', label: 'duplicating channels', status: 'unavailable' }] }] } as never;
    expect(unavailableReason(report, 'channel-admin', 'copy')).toContain('duplicating channels');
    expect(unavailableReason(report, 'channel-admin', 'create')).toBeNull();
  });

  it('never takes an API description that failed to load as proof a write is missing', () => {
    const decided = decide(spec('custom-shows'), { ops: null, description: 'failed', liveStreams: 0, probes: { customShows: ok } });
    expect(decided).toMatchObject({ status: 'degraded', reason: expect.stringContaining('didn’t load just now') });
    expect(decided.parts?.every((part) => part.status === 'unchecked')).toBe(true);
    const report = { checkedAt: 0, configured: true, connected: true, version: checkVersion(null, 'none'), apiDescription: 'failed' as const, capabilities: [{ id: 'custom-shows' as const, label: 'Custom shows', uses: '', ...decided }] };
    expect(partBlocked(report, 'custom-shows', 'delete')).toBeNull();
    expect(decide(spec('custom-shows'), { ops: null, description: 'failed', liveStreams: 0, probes: { customShows: { ok: false, kind: 'failed', reason: 'Tunarr didn’t answer in time.' } } }).status).toBe('degraded');
  });

  it('never starts a stream: HLS is available only when Tunarr is already streaming', () => {
    expect(decide(spec('hls-streaming'), { ops: allOps, liveStreams: 2, probes: {} }).status).toBe('available');
    expect(decide(spec('hls-streaming'), { ops: allOps, liveStreams: 0, probes: {} }).status).toBe('untested');
  });

  it('normalizes OpenAPI path parameters', () => {
    expect(describedOperations({ paths: { '/api/channels/{channelId}/schedule-slots/': { post: {} } } })).toEqual(new Set(['post /api/channels/{}/schedule-slots']));
    expect(describedOperations('<html>')).toBeNull();
  });
});

describe('Tunarr versions', () => {
  it('validates 1.x, warns outside it, and reports unrecognized or missing versions', () => {
    expect(checkVersion('1.3.13', 'api').status).toBe('validated');
    expect(checkVersion('v1.0.0-beta.2', 'api').status).toBe('validated');
    expect(checkVersion('0.22.4', 'api').status).toBe('unvalidated');
    expect(checkVersion('2.0.0', 'api').status).toBe('unvalidated');
    expect(checkVersion('dev-build', 'api')).toMatchObject({ status: 'unknown', tunarr: 'dev-build' });
    expect(checkVersion(null, 'none').status).toBe('unknown');
  });

  it('only shows plain version strings', () => {
    expect(cleanVersion(' 1.2.3 ')).toBe('1.2.3');
    expect(cleanVersion('<script>')).toBeNull();
    expect(cleanVersion(42)).toBeNull();
    expect(versionLine('0.9.0', 'unvalidated')).toBe('Tunarr 0.9.0 (not validated)');
  });
});

describe('Tunarr route missing', () => {
  it('recognizes Fastify’s own 404 and answers 501 tunarr_unsupported', async () => {
    expect(routeMissing(new TextEncoder().encode('{"message":"Route GET:/api/sessions not found","error":"Not Found","statusCode":404}'))).toBe(true);
    expect(routeMissing(new TextEncoder().encode('{"error":"Channel Not Found"}'))).toBe(false);
    const fake = fakeTunarr();
    const config = configFor(fake);
    await expect(callTunarr(config, target, 'GET', '/api/nothing-here')).rejects.toMatchObject({ status: 501, code: 'tunarr_unsupported' });
    // A missing channel is still "not found".
    const missing = fakeTunarr({ overrides: { [`/api/channels/${CHANNEL}`]: () => json({ error: 'Channel Not Found' }, 404) } });
    await expect(callTunarr(configFor(missing), target, 'GET', `/api/channels/${CHANNEL}`)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});

describe('detecting what Tunarr can do', () => {
  it('reports a known version with every capability, reading only', async () => {
    const fake = fakeTunarr();
    const report = await detectCompatibility(configFor(fake), target, 1_000);
    expect(report).toMatchObject({ connected: true, configured: true, apiDescription: 'read', version: { tunarr: '1.3.13', source: 'api', status: 'validated' } });
    for (const capability of report.capabilities) expect([capability.id, capability.status]).toEqual([capability.id, capability.id === 'hls-streaming' ? 'untested' : 'available']);
    // Read-only: GETs, plus one search for a single result.
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    expect(writes).toEqual([{ method: 'POST', url: '/api/programs/search', body: JSON.stringify({ mediaSourceId: SOURCE, libraryId: LIBRARY, query: {}, page: 0, limit: 1 }) }]);
    // The smallest channel is read, never the 9,000-item one.
    expect(fake.calls.some((call) => call.url.includes(BIG))).toBe(false);
    expect(fake.calls.find((call) => call.url.startsWith('/api/guide/channels'))?.url).toContain('dateFrom=1970-01-01T00%3A00%3A01.000Z');
  });

  it('reads every manager’s writes from the API description, writing nothing', async () => {
    const fake = fakeTunarr({ openapi: { info: { version: '1.3.13' }, paths: without('post /api/custom-shows', 'put /api/custom-shows/{}', 'delete /api/custom-shows/{}', 'delete /api/media-sources/{}') } });
    const report = await detectCompatibility(configFor(fake), target);
    expect(statusOf(report, 'custom-shows')).toBe('degraded');
    expect(statusOf(report, 'media-sources')).toBe('degraded');
    expect(statusOf(report, 'filler-lists')).toBe('available');
    expect(report.capabilities.find((item) => item.id === 'custom-shows')?.parts?.filter((part) => part.status === 'unavailable').map((part) => part.id)).toEqual(['create', 'edit', 'delete']);
    expect(blockedCapabilities(report).map((item) => item.id)).toEqual([]);
    expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => call.url)).toEqual(['/api/programs/search']);
  });

  it('keeps writes on, unchecked, when the API description fails to load', async () => {
    const fake = fakeTunarr({ overrides: { '/openapi.json': () => json({ error: 'boom' }, 500) } });
    const report = await detectCompatibility(configFor(fake), target);
    expect(report.apiDescription).toBe('failed');
    expect(blockedCapabilities(report)).toEqual([]);
    for (const capability of report.capabilities) expect([capability.id, capability.parts?.every((part) => part.status === 'unchecked') ?? true]).toEqual([capability.id, true]);
    expect(statusOf(report, 'filler-lists')).toBe('degraded');
    expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => call.url)).toEqual(['/api/programs/search']);
  });

  it('never passes on Tunarr’s address, credentials, or other upstream details', async () => {
    const fake = fakeTunarr({ overrides: { '/api/sessions': () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } } });
    const report = await detectCompatibility(configFor(fake), target);
    const shown = JSON.stringify(report);
    for (const secret of ['secret-host', 's3cret', 'c2VjcmV0', '10.0.0.9', 'plex-token', 'secret-build']) expect(shown).not.toContain(secret);
    // A connection reset may pass: usable, not turned off.
    expect(statusOf(report, 'sessions')).toBe('degraded');
    for (const capability of report.capabilities) expect(capability.reason).not.toMatch(/ECONNRESET|fetch failed/);
  });

  it('works without a version endpoint or API description', async () => {
    const fake = fakeTunarr({ version: null, openapi: null });
    const report = await detectCompatibility(configFor(fake), target);
    expect(report.version).toMatchObject({ tunarr: null, status: 'unknown' });
    expect(report.apiDescription).toBe('missing');
    expect(statusOf(report, 'programming')).toBe('available');
    // Writes can't be checked without writing, so they're left to be tried, not refused.
    expect(statusOf(report, 'manual-saves')).toBe('untested');
    expect(statusOf(report, 'slot-schedules')).toBe('untested');
    expect(blockedCapabilities(report)).toEqual([]);
  });

  it('takes the version from the API description when /api/version is missing, and warns about unknown versions', async () => {
    const fake = fakeTunarr({ version: null, openapi: { info: { version: '0.20.1' }, paths: ALL_PATHS } });
    const report = await detectCompatibility(configFor(fake), target);
    expect(report.version).toMatchObject({ tunarr: '0.20.1', source: 'openapi', status: 'unvalidated' });
  });

  it('degrades only what answers oddly and refuses only what is missing', async () => {
    const paths = { ...ALL_PATHS };
    delete paths['/api/channels/{channelId}/schedule-slots'];
    const fake = fakeTunarr({
      openapi: { info: {}, paths },
      overrides: {
        [`/api/channels/${CHANNEL}/programming`]: () => json({ lineup: [] }),
        '/api/sessions': () => routeNotFound('GET', '/api/sessions'),
      },
    });
    const report = await detectCompatibility(configFor(fake), target);
    expect(statusOf(report, 'programming')).toBe('degraded');
    expect(statusOf(report, 'sessions')).toBe('unavailable');
    expect(statusOf(report, 'slot-schedules')).toBe('unavailable');
    expect(statusOf(report, 'guide')).toBe('available');
    expect(statusOf(report, 'manual-saves')).toBe('available');
    expect(blockedReason(report, 'sessions')).toContain('Viewer counts isn’t available');
    expect(blockedReason(report, 'programming')).toBeNull();
    expect(blockedCapabilities(report).map((item) => item.id)).toEqual(['slot-schedules', 'sessions']);
    // Something that isn't a report (an older companion, an error page) refuses nothing.
    expect(blockedReason({} as never, 'sessions')).toBeNull();
    expect(blockedCapabilities({ capabilities: 'x' } as never)).toEqual([]);
  });

  it('reports Tunarr down without hiding it', async () => {
    const fake = fakeTunarr({ overrides: { '/api/channels': () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } } });
    const report = await detectCompatibility(configFor(fake), target);
    expect(report).toMatchObject({ connected: false, connectionError: 'Lineup couldn’t reach Tunarr.' });
    expect(report.capabilities.every((item) => item.status === 'unknown')).toBe(true);
    expect(blockedCapabilities(report)).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it('handles no channels and no libraries yet', async () => {
    const fake = fakeTunarr({ overrides: { '/api/channels': () => json([]), '/api/media-sources': () => json([]) } });
    const report = await detectCompatibility(configFor(fake), target);
    expect(statusOf(report, 'programming')).toBe('untested');
    expect(statusOf(report, 'channel-settings')).toBe('untested');
    expect(statusOf(report, 'library-search')).toBe('untested');
  });
});

describe('/api/tunarr/compatibility', () => {
  it('answers without Tunarr’s address, saying it isn’t set up', async () => {
    const response = await handleTunarrApi(get('/api/tunarr/compatibility'), createProxyConfig({ LINEUP_DATA_DIR: testDataDir }));
    expect(response.status).toBe(200);
    expect(JSON.parse(text(response))).toMatchObject({ configured: false, connected: false });
  });

  it('caches for five minutes, refreshes on request, and never shows the address', async () => {
    const fake = fakeTunarr();
    const config = configFor(fake);
    const first = await handleTunarrApi(get('/api/tunarr/compatibility'), config);
    expect(first.status).toBe(200);
    expect(text(first)).not.toContain('secret-host');
    const reads = fake.calls.length;
    await handleTunarrApi(get('/api/tunarr/compatibility'), config);
    expect(fake.calls.length).toBe(reads);
    const refreshed = await handleTunarrApi(post('/api/tunarr/compatibility/refresh'), config);
    expect(refreshed.status).toBe(200);
    expect(fake.calls.length).toBe(reads * 2);
    expect((await handleTunarrApi({ ...post('/api/tunarr/compatibility'), body: '{}' }, config)).status).toBe(405);
    expect((await handleTunarrApi(get('/api/tunarr/compatibility?x=1'), config)).status).toBe(400);
  });

  it('checks again when Tunarr’s address changes', async () => {
    const fake = fakeTunarr();
    const config = configFor(fake);
    await compatibility(config);
    const reads = fake.calls.length;
    config.target = { origin: 'http://other:8000', basePath: '', host: 'other:8000' };
    await compatibility(config);
    expect(fake.calls.length).toBe(reads * 2);
  });

  it('shares one check between requests that arrive together', async () => {
    const fake = fakeTunarr();
    const config = configFor(fake);
    await Promise.all([compatibility(config, { refresh: true }), compatibility(config, { refresh: true })]);
    expect(fake.calls.filter((call) => call.url === '/api/version')).toHaveLength(1);
  });
});

describe('diagnostics file', () => {
  it('holds the report without addresses or upstream details', async () => {
    const fake = fakeTunarr();
    const file = diagnosticsFile(await detectCompatibility(configFor(fake), target), Date.UTC(2026, 9, 25));
    expect(file).toMatchObject({ format: 'tunarr-lineup-diagnostics', formatVersion: 2, exportedAt: '2026-10-25T00:00:00.000Z', connected: true });
    expect(JSON.stringify(file)).not.toMatch(/secret|token|10\.0\.0\.9/);
  });
});
