import { describe, expect, it } from 'vitest';
import { manageableSources, validateMediaSourceAdd, validateTranscodeChanges } from '../server/admin';
import { clearLogoCache, isPublicAddress, logoSource } from '../server/logos';
import { describeRules, filterToRules, rulesToFilter } from '../server/smartCollection';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest, type TunarrTarget } from '../server/tunarrProxy';

const UUID_A = '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a';
const UUID_B = '1e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7b';
const PROFILE = '07925780-d3ba-476e-ba5c-bf0d89c58245';

type Call = { url: string; method: string; body?: unknown };

function harness(reply: (url: string, method: string, body: unknown) => unknown, extra: Partial<ProxyConfig> = {}) {
  const calls: Call[] = [];
  const config: ProxyConfig = {
    ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000' }),
    ...extra,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('http://tunarr:8000', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const data = reply(url, method, body);
      if (data instanceof Response) return data;
      return data === undefined ? new Response(null, { status: 200 }) : Response.json(data, { status: method === 'POST' && url === '/api/channels' ? 201 : 200 });
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

describe('channels', () => {
  const channels = [{ id: 'chan-1', number: 1, name: 'One' }, { id: 'chan-7', number: 7, name: 'Seven' }];

  it('creates a channel with Tunarr’s defaults, the next number and the default profile', async () => {
    const { calls, config } = harness((url, method) => {
      if (url === '/api/channels' && method === 'GET') return channels;
      if (url === '/api/transcode_configs') return [{ id: UUID_A, isDefault: false }, { id: PROFILE, isDefault: true }];
      return { id: 'new-id' };
    });
    const response = await handleTunarrApi(req('POST', '/channels/create', { name: '  Late Movies ' }), config);
    expect(response.status).toBe(201);
    expect(parse(response)).toEqual({ id: 'new-id', name: 'Late Movies', number: 8 });
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/channels');
    expect(post.body).toMatchObject({ type: 'new', channel: { name: 'Late Movies', number: 8, transcodeConfigId: PROFILE, streamMode: 'hls', groupTitle: 'tunarr', offline: { mode: 'pic' }, icon: { path: '' } } });
    expect((post.body as { channel: { id: string } }).channel.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('copies a channel, then applies the requested name and number', async () => {
    const { calls, config } = harness((url, method) => {
      if (url === '/api/channels' && method === 'GET') return channels;
      if (url === '/api/channels' && method === 'POST') return { id: 'copy-id' };
      if (url === '/api/channels/copy-id' && method === 'GET') return { id: 'copy-id', name: 'One copy', number: 99, programCount: 3, sessions: [], transcodeConfigId: PROFILE };
      return {};
    });
    const response = await handleTunarrApi(req('POST', '/channels/create', { name: 'One again', number: 12, copyFrom: 'chan-1' }), config);
    expect(response.status).toBe(201);
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ type: 'copy', channelId: 'chan-1' });
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toBe('/api/channels/copy-id');
    expect(put.body).toMatchObject({ name: 'One again', number: 12, transcodeConfigId: PROFILE });
    expect('programCount' in (put.body as object) || 'sessions' in (put.body as object)).toBe(false);
  });

  it('refuses a taken number and bad input before calling Tunarr to write', async () => {
    const { calls, config } = harness(() => channels);
    expect((await handleTunarrApi(req('POST', '/channels/create', { name: 'Dup', number: 7 }), config)).status).toBe(409);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect((await handleTunarrApi(req('POST', '/channels/create', { name: '' }), config)).status).toBe(400);
    expect((await handleTunarrApi(req('POST', '/channels/create', { name: 'x', copyFrom: '../etc' }), config)).status).toBe(400);
  });

  it('deletes a channel by id only', async () => {
    const { calls, config } = harness(() => undefined);
    expect((await handleTunarrApi(req('DELETE', '/channels/chan-1'), config)).status).toBe(200);
    expect(calls).toEqual([{ url: '/api/channels/chan-1', method: 'DELETE', body: undefined }]);
    expect((await handleTunarrApi(req('DELETE', '/channels/chan%2F1'), config)).status).toBe(400);
    expect((await handleTunarrApi(req('DELETE', '/channels/chan-1', undefined, { origin: 'https://evil.example' }), config)).status).toBe(403);
  });
});

describe('transcode profiles', () => {
  const profile = { id: PROFILE, name: 'Default', isDefault: true, vaapiDevice: '/dev/dri/renderD128', vaapiDriver: 'system', videoBitRate: 2000, resolution: { widthPx: 1920, heightPx: 1080 }, videoFormat: 'h264' };

  it('validates changes against an allowlist', () => {
    expect(validateTranscodeChanges({ videoBitRate: 4000, resolution: { widthPx: 1280, heightPx: 720 } })).toEqual({ changes: { videoBitRate: 4000, resolution: { widthPx: 1280, heightPx: 720 } } });
    expect(validateTranscodeChanges({ vaapiDevice: '/dev/sda' })).toHaveProperty('error');
    expect(validateTranscodeChanges({ videoFormat: 'av1' })).toHaveProperty('error');
    expect(validateTranscodeChanges({ hardwareAccelerationMode: 'cuda', audioLoudnormConfig: null })).toHaveProperty('changes');
  });

  it('merges edits onto Tunarr’s copy and keeps fields Lineup does not edit', async () => {
    const { calls, config } = harness((url, method, body) => (method === 'PUT' ? body : profile));
    const response = await handleTunarrApi(req('PUT', `/transcode-configs/${PROFILE}`, { videoBitRate: 6000 }), config);
    expect(response.status).toBe(200);
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ ...profile, videoBitRate: 6000 });
    // The device path is kept on Tunarr's side, not shown.
    expect(text(response)).not.toContain('/dev/dri');
  });

  it('won’t delete the default profile or one channels use', async () => {
    const { config } = harness((url) => (url === '/api/channels' ? [{ id: 'a', transcodeConfigId: UUID_A }] : url.includes(PROFILE) ? profile : { id: UUID_A, isDefault: false }));
    expect((await handleTunarrApi(req('DELETE', `/transcode-configs/${PROFILE}`), config)).status).toBe(409);
    const inUse = await handleTunarrApi(req('DELETE', `/transcode-configs/${UUID_A}`), config);
    expect(inUse.status).toBe(409);
    expect(parse(inUse).error.message).toMatch(/1 channel uses/);
  });
});

describe('media sources', () => {
  const sources = [{
    id: UUID_A, name: 'Plex', type: 'plex', uri: 'http://10.0.0.5:32400', accessToken: 'tok-secret', username: 'owner', paths: ['/srv/media'],
    libraries: [{ id: UUID_B, name: 'Movies', mediaType: 'movies', enabled: false, lastScannedAt: 5 }],
  }];

  it('lists sources with every library but no addresses, tokens or accounts', async () => {
    const { config } = harness(() => sources);
    const response = await handleTunarrApi(req('GET', '/media-sources/manage'), config);
    expect(parse(response)).toEqual([{ id: UUID_A, name: 'Plex', type: 'plex', libraries: [{ id: UUID_B, name: 'Movies', mediaType: 'movies', enabled: false, lastScannedAt: 5, isLocked: false }] }]);
    expect(text(response)).not.toMatch(/10\.0\.0\.5|tok-secret|owner|srv/);
    expect(manageableSources(null)).toEqual([]);
  });

  it('validates new sources', () => {
    expect(validateMediaSourceAdd({ type: 'plex', name: 'P', uri: 'http://192.168.1.2:32400/', accessToken: 'abcDEF123456' })).toEqual({ kind: 'insert', body: expect.objectContaining({ type: 'plex', uri: 'http://192.168.1.2:32400', accessToken: 'abcDEF123456', pathReplacements: [] }) });
    expect(validateMediaSourceAdd({ type: 'plex', name: 'P', uri: 'http://user:pw@host', accessToken: 'abcDEF123456' })).toHaveProperty('error');
    expect(validateMediaSourceAdd({ type: 'plex', name: 'P', uri: 'file:///etc', accessToken: 'abcDEF123456' })).toHaveProperty('error');
    expect(validateMediaSourceAdd({ type: 'local', name: 'L', mediaType: 'movies', paths: ['relative/path'] })).toHaveProperty('error');
    expect(validateMediaSourceAdd({ type: 'local', name: 'L', mediaType: 'movies', paths: ['/media/movies'] })).toMatchObject({ kind: 'insert', body: { type: 'local', paths: ['/media/movies'] } });
    expect(validateMediaSourceAdd({ type: 'ftp', name: 'x' })).toHaveProperty('error');
  });

  it('signs in to Jellyfin through Tunarr and never returns the token', async () => {
    const { calls, config } = harness((url) => {
      if (url === '/api/jellyfin/login') return { accessToken: 'jf-token', userId: 'u1' };
      if (url === '/api/media-sources') return { id: UUID_A };
      return undefined;
    });
    const response = await handleTunarrApi(req('POST', '/media-sources/add', { type: 'jellyfin', name: 'JF', uri: 'http://192.168.1.3:8096', username: 'me', password: 'pw' }), config);
    expect(response.status).toBe(201);
    expect(text(response)).not.toMatch(/jf-token|pw/);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/jellyfin/login', 'POST /api/media-sources', `POST /api/media-sources/${UUID_A}/libraries/refresh`]);
    expect(calls[1].body).toMatchObject({ type: 'jellyfin', uri: 'http://192.168.1.3:8096', accessToken: 'jf-token', userId: 'u1', username: 'me' });
    expect(JSON.stringify(calls[1].body)).not.toContain('"password"');
  });

  it('reports a failed sign-in without upstream detail', async () => {
    const { config } = harness(() => new Response(JSON.stringify({ reason: 'auth' }), { status: 502 }));
    const response = await handleTunarrApi(req('POST', '/media-sources/add', { type: 'emby', name: 'E', uri: 'http://e:8096', username: 'me', password: 'bad' }), config);
    expect(response.status).toBe(502);
    expect(parse(response).error.code).toBe('media_server_login_failed');
  });

  it('turns libraries on and scans them', async () => {
    const { calls, config } = harness((url, method, body) => (method === 'PUT' ? { id: UUID_B, ...(body as object) } : undefined));
    expect(parse(await handleTunarrApi(req('PUT', `/media-sources/${UUID_A}/libraries/${UUID_B}`, { enabled: true }), config))).toEqual({ id: UUID_B, enabled: true });
    expect((await handleTunarrApi(req('POST', `/media-sources/${UUID_A}/libraries/${UUID_B}/scan`, {}), config)).status).toBe(202);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`PUT /api/media-sources/${UUID_A}/libraries/${UUID_B}`, `POST /api/media-sources/${UUID_A}/libraries/${UUID_B}/scan?forceScan=true`]);
    expect((await handleTunarrApi(req('PUT', `/media-sources/${UUID_A}/libraries/${UUID_B}`, { enabled: 'yes' }), config)).status).toBe(400);
    expect((await handleTunarrApi(req('DELETE', '/media-sources/not-a-uuid'), config)).status).toBe(400);
  });
});

describe('smart collections', () => {
  const NOW = Date.UTC(2026, 9, 3);

  it('turns rules into Tunarr’s filter tree', () => {
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'genre', op: 'is', values: ['Comedy', ' Drama '] }, { field: 'minutes', op: '<=', value: 30 }] }, NOW)).toEqual({ filter: {
      type: 'op', op: 'and', children: [
        { type: 'value', fieldSpec: { key: 'genres.name', name: 'genre', op: 'in', type: 'faceted_string', value: ['Comedy', 'Drama'] } },
        { type: 'value', fieldSpec: { key: 'duration', name: 'minutes', op: '<=', type: 'numeric', value: 30 * 60_000 } },
      ],
    } });
    expect(rulesToFilter({ match: 'any', rules: [{ field: 'added_date', op: 'inthelast', amount: 2, unit: 'week' }] }, NOW)).toEqual({ filter: {
      type: 'value', fieldSpec: { key: 'addedAt', name: 'added_date', op: '>=', type: 'date', value: NOW - 14 * 86_400_000, relativeDate: { op: 'inthelast', amount: 2, unit: 'week' } },
    } });
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'year', op: 'between', value: 1990, value2: 1999 }] })).toMatchObject({ filter: { fieldSpec: { op: 'to', value: [1990, 1999] } } });
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'password', op: 'is', values: ['x'] }] })).toHaveProperty('error');
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'genre', op: 'is', values: [] }] })).toHaveProperty('error');
    expect(rulesToFilter({ match: 'xor', rules: [] })).toHaveProperty('error');
  });

  it('reads stored filters back as rules, or reports that it can’t', () => {
    const set = { match: 'any' as const, rules: [{ field: 'studio', op: 'is', values: ['Pixar'] }, { field: 'year', op: '>=', value: 2000 }] };
    const built = rulesToFilter(set);
    expect('filter' in built && filterToRules(built.filter)).toEqual(set);
    expect(describeRules(set)).toBe('Studio is Pixar or Year ≥ 2000');
    expect(filterToRules({ type: 'op', op: 'and', children: [{ type: 'op', op: 'or', children: [] }] })).toBeNull();
  });

  it('creates, previews and protects collections', async () => {
    const { calls, config } = harness((url, method, body) => {
      if (url === '/api/programs/search') return { totalHits: 42, results: [{ uuid: UUID_A, title: 'Toy Story', type: 'movie', year: 1995, secret: 'x' }] };
      if (method === 'POST') return { uuid: UUID_B, ...(body as object), filterString: 'studio = "Pixar"' };
      return undefined;
    });
    const created = await handleTunarrApi(req('POST', '/smart-collections/create', { name: 'Pixar', match: 'all', rules: [{ field: 'studio', op: 'is', values: ['Pixar'] }] }), config);
    expect(created.status).toBe(201);
    expect(parse(created)).toMatchObject({ id: UUID_B, name: 'Pixar', rules: { match: 'all', rules: [{ field: 'studio', op: 'is', values: ['Pixar'] }] }, description: 'Studio is Pixar' });
    expect(calls[0].body).toMatchObject({ name: 'Pixar', keywords: '', filter: { fieldSpec: { key: 'studio.name', op: '=' } } });

    const preview = await handleTunarrApi(req('POST', '/smart-collections/preview', { match: 'all', rules: [{ field: 'studio', op: 'is', values: ['Pixar'] }] }), config);
    expect(parse(preview)).toEqual({ totalHits: 42, sample: [{ id: UUID_A, title: 'Toy Story', type: 'movie', year: 1995 }] });
    expect(calls[1].body).toMatchObject({ page: 0, limit: 12 });

    expect((await handleTunarrApi(req('PUT', `/smart-collections/${UUID_B}`, { match: 'all', rules: [] }), config)).status).toBe(400);
    expect((await handleTunarrApi(req('POST', '/smart-collections/create', { name: 'Empty', match: 'all', rules: [] }), config)).status).toBe(400);
  });
});

describe('channel logos', () => {
  const target: TunarrTarget = { origin: 'http://tunarr:8000', basePath: '', host: 'tunarr:8000' };
  const png = new Uint8Array([137, 80, 78, 71]);

  it('serves uploaded logos from Tunarr whatever host they were saved under', () => {
    expect(logoSource('http://host.docker.internal:8000/images/uploads/a.png', target)).toMatchObject({ kind: 'tunarr', path: '/images/uploads/a.png' });
    expect(logoSource('https://home.tail1.ts.net:8443/images/uploads/b_icon.png', target)).toMatchObject({ kind: 'tunarr', path: '/images/uploads/b_icon.png' });
    expect(logoSource('/images/tunarr.png', target)).toEqual({ kind: 'tunarr', path: '/images/tunarr.png' });
    expect(logoSource('https://i.ytimg.com/vi/x/hq.jpg', target)).toMatchObject({ kind: 'external' });
    expect(logoSource('http://tunarr:8000/images/../api/settings', target)).toBeNull();
    expect(logoSource('/images/uploads/%2e%2e/%2e%2e/api', target)).toBeNull();
    expect(logoSource('/api/settings', target)).toBeNull();
    expect(logoSource('file:///etc/passwd', target)).toBeNull();
    expect(logoSource('', target)).toBeNull();
  });

  it('only fetches public addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '100.101.102.103', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', 'fe80::1']) expect(isPublicAddress(address)).toBe(false);
    for (const address of ['142.250.1.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(address)).toBe(true);
  });

  it('proxies the image bytes and caches them', async () => {
    clearLogoCache();
    const { calls, config } = harness((url) => (url === '/api/channels/chan-1'
      ? { icon: { path: 'http://localhost:8000/images/uploads/logo.png' } }
      : new Response(png, { headers: { 'content-type': 'image/png' } })));
    const first = await handleTunarrApi(req('GET', '/channels/chan-1/logo?v=abc123'), config);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.body).toEqual(png);
    await handleTunarrApi(req('GET', '/channels/chan-1/logo'), config);
    expect(calls.filter((call) => call.url.startsWith('/images')).length).toBe(1);
    expect((await handleTunarrApi(req('GET', '/channels/chan-1/logo?url=http://x'), config)).status).toBe(400);
  });

  it('loads public logos through the guarded fetch, and can be turned off', async () => {
    clearLogoCache();
    const fetched: string[] = [];
    const external = async (url: URL) => { fetched.push(url.href); return { contentType: 'image/jpeg', bytes: png }; };
    const reply = () => ({ icon: { path: 'https://image.tmdb.org/t/p/original/x.jpg' } });
    const on = harness(reply, { fetchExternalImage: external });
    expect((await handleTunarrApi(req('GET', '/channels/chan-2/logo'), on.config)).status).toBe(200);
    expect(fetched).toEqual(['https://image.tmdb.org/t/p/original/x.jpg']);
    clearLogoCache();
    const off = harness(reply, { fetchExternalImage: external, externalLogos: false });
    expect((await handleTunarrApi(req('GET', '/channels/chan-2/logo'), off.config)).status).toBe(204);
    expect(fetched.length).toBe(1);
  });

  it('answers 204 when a channel has no logo, and rejects non-images', async () => {
    clearLogoCache();
    expect((await handleTunarrApi(req('GET', '/channels/chan-3/logo'), harness(() => ({ icon: { path: '' } })).config)).status).toBe(204);
    const html = harness((url) => (url === '/api/channels/chan-4' ? { icon: { path: '/images/uploads/x.png' } } : new Response('<html>', { headers: { 'content-type': 'text/html' } })));
    expect((await handleTunarrApi(req('GET', '/channels/chan-4/logo'), html.config)).status).toBe(502);
  });
});
