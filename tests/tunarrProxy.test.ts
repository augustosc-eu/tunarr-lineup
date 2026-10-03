import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNodeApiRequest } from '../server/nodeAdapter';
import { programmingVersion } from '../server/lineupVersion';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

type Call = { url: string; init: RequestInit };

function setup(responder: (url: string, init: RequestInit) => Promise<Response> | Response, env: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder(String(input), init ?? {});
  });
  const config: ProxyConfig = { ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000', ...env }), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { calls, config, fetchImpl };
}

const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const get = (url: string, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local:3000', ...headers } });

const text = (response: { body: string | Uint8Array }) => (typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const body = (response: { body: string | Uint8Array }) => JSON.parse(text(response));

const channels = [{ id: 'f6a4c3d2-1111-4222-8333-944455556666', name: 'Movies', number: 1, startTime: 0, duration: 1000 }];

describe('Tunarr proxy routes', () => {
  it('loads channels from TUNARR_URL/api/channels', async () => {
    const { calls, config } = setup(() => jsonResponse(channels));
    const response = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(response.status).toBe(200);
    expect(body(response)).toEqual(channels);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://tunarr:8000/api/channels');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.redirect).toBe('manual');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports a connected health check with the host only', async () => {
    const { calls, config } = setup(() => jsonResponse(channels), { TUNARR_URL: 'http://admin:s3cret@tunarr:8000' });
    const response = await handleTunarrApi(get('/api/tunarr/health'), config);
    expect(response.status).toBe(200);
    expect(body(response)).toEqual({ status: 'connected', tunarrHost: 'tunarr:8000', channelCount: 1 });
    expect(text(response)).not.toContain('s3cret');
    // Credentials in TUNARR_URL become an explicit upstream header, never part of the URL.
    expect(calls[0].url).toBe('http://tunarr:8000/api/channels');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);
  });

  it('supports a base path in TUNARR_URL', async () => {
    const { calls, config } = setup(() => jsonResponse(channels), { TUNARR_URL: 'https://media.example.com/tunarr/' });
    await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(calls[0].url).toBe('https://media.example.com/tunarr/api/channels');
  });

  it('explains when TUNARR_URL is missing', async () => {
    const config = createProxyConfig({});
    const health = await handleTunarrApi(get('/api/tunarr/health'), config);
    expect(health.status).toBe(503);
    expect(body(health)).toMatchObject({ status: 'not_configured', error: { code: 'not_configured' } });
    expect(body(health).error.message).toContain('TUNARR_URL');
    const list = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(list.status).toBe(503);
    expect(body(list).error.code).toBe('not_configured');
  });

  it('rejects an invalid TUNARR_URL without echoing it', async () => {
    const config = createProxyConfig({ TUNARR_URL: 'ftp://user:pw@nas/' });
    const health = await handleTunarrApi(get('/api/tunarr/health'), config);
    expect(health.status).toBe(503);
    expect(body(health).error.code).toBe('invalid_config');
    expect(text(health)).not.toContain('pw@');
  });

  it('reports unreachable Tunarr with the hostname but no credentials', async () => {
    const { config } = setup(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, { TUNARR_URL: 'http://admin:s3cret@192.168.1.50:8000' });
    const health = await handleTunarrApi(get('/api/tunarr/health'), config);
    expect(health.status).toBe(502);
    expect(body(health)).toMatchObject({ status: 'unreachable', tunarrHost: '192.168.1.50:8000', error: { code: 'tunarr_unreachable' } });
    expect(body(health).error.message).toBe('Could not reach Tunarr at 192.168.1.50:8000 (ECONNREFUSED).');
    expect(text(health)).not.toMatch(/s3cret|admin/);

    const list = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(list.status).toBe(502);
    expect(body(list).error).toMatchObject({ code: 'tunarr_unreachable', tunarrHost: '192.168.1.50:8000' });
  });

  it('times out a slow upstream with 504', async () => {
    const { config } = setup((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }), { TUNARR_TIMEOUT_MS: '25' });
    const started = Date.now();
    const response = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(response.status).toBe(504);
    expect(body(response).error.code).toBe('tunarr_timeout');
    expect(body(response).error.message).toContain('tunarr:8000');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    '/api/tunarr/channels/..%2F..%2Fsettings/programming',
    '/api/tunarr/channels/abc%2Fdef/programming',
    '/api/tunarr/channels/-leading-dash/programming',
    `/api/tunarr/channels/${'a'.repeat(65)}/programming`,
  ])('rejects invalid channel id %s', async (url) => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi(get(url), config);
    expect(response.status).toBe(400);
    expect(body(response).error.code).toBe('invalid_channel_id');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/tunarr/settings', 404],
    ['GET', '/api/tunarr/channels/abc', 404],
    ['GET', '/api/tunarr/channels/abc/programs', 404],
    ['GET', '/api/tunarr/http://evil.example/api/channels', 404],
    ['GET', '/api/tunarr/channels/../../system/settings', 404],
    ['GET', '/api/tunarr/channels/%2e%2e/lineup', 404],
    ['DELETE', '/api/tunarr/channels/abc/programming', 405],
    ['PUT', '/api/tunarr/channels/abc/programming', 405],
    ['POST', '/api/tunarr/channels', 405],
    ['POST', '/api/tunarr/channels/abc/lineup', 405],
    ['GET', '/api/tunarr/channels?url=http://evil.example', 400],
    ['GET', '/api/tunarr/channels/abc/programming?offset=0', 400],
  ])('blocks %s %s', async (method, url, status) => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi({ ...get(url), method }, config);
    expect(response.status).toBe(status);
    expect(body(response).error.code).toMatch(/route_not_allowed|method_not_allowed|invalid_query/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns existing programming for a channel', async () => {
    const programming = { lineup: [{ type: 'content', id: 'p1', duration: 60000, persisted: true }], programs: { p1: { title: 'X' } }, totalPrograms: 1, startTimeOffsets: [0] };
    const { calls, config } = setup(() => jsonResponse(programming));
    const response = await handleTunarrApi(get('/api/tunarr/channels/f6a4c3d2-1111-4222-8333-944455556666/programming'), config);
    expect(response.status).toBe(200);
    expect(body(response)).toEqual(programming);
    expect(calls[0].url).toBe('http://tunarr:8000/api/channels/f6a4c3d2-1111-4222-8333-944455556666/programming');
  });

  it('maps an upstream 404 to a normalized error', async () => {
    const { config } = setup(() => jsonResponse({ error: 'Channel Not Found' }, 404));
    const response = await handleTunarrApi(get('/api/tunarr/channels/abc/programming'), config);
    expect(response.status).toBe(404);
    expect(body(response).error.code).toBe('not_found');
  });

  it('normalizes upstream failures without leaking internals', async () => {
    const { config } = setup(() => new Response('Error: boom\n    at Object.<anonymous> (/app/server.js:1:1)', { status: 500 }));
    const response = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(response.status).toBe(502);
    expect(body(response).error).toEqual({ code: 'tunarr_error', message: 'Tunarr at tunarr:8000 returned HTTP 500.', tunarrHost: 'tunarr:8000' });
  });

  it('does not follow upstream redirects', async () => {
    const { config } = setup(() => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    const response = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(response.status).toBe(502);
    expect(body(response).error.code).toBe('tunarr_redirect');
  });

  it('rejects non-JSON upstream responses', async () => {
    const { config } = setup(() => new Response('<html>login</html>', { status: 200 }));
    const response = await handleTunarrApi(get('/api/tunarr/channels'), config);
    expect(response.status).toBe(502);
    expect(body(response).error.code).toBe('tunarr_invalid_response');
  });
});

describe('lineup date range', () => {
  it('forwards a validated, normalized range', async () => {
    const { calls, config } = setup(() => jsonResponse({ id: 'abc', programs: [] }));
    const response = await handleTunarrApi(get('/api/tunarr/channels/abc/lineup?from=2026-10-02T00:00:00-04:00&to=2026-10-03T04:00:00.000Z'), config);
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('http://tunarr:8000/api/channels/abc/lineup?from=2026-10-02T04%3A00%3A00.000Z&to=2026-10-03T04%3A00%3A00.000Z');
  });

  it.each([
    '',
    '?from=2026-10-02T00:00:00Z',
    '?from=yesterday&to=today',
    '?from=2026-10-03T00:00:00Z&to=2026-10-02T00:00:00Z',
    '?from=2026-10-01T00:00:00Z&to=2026-10-30T00:00:00Z',
    '?from=2026-10-02T00:00:00Z&to=2026-10-03T00:00:00Z&includePrograms=true',
    '?from=2026-10-02T00:00:00Z&from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z',
  ])('rejects query %s', async (query) => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi(get(`/api/tunarr/channels/abc/lineup${query}`), config);
    expect(response.status).toBe(400);
    expect(body(response).error.code).toBe('invalid_query');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('saving manual programming', () => {
  const lineup = [
    { type: 'content', id: 'p2', duration: 1800000, persisted: true, startOffsetMs: 5000 },
    { type: 'flex', duration: 600000, persisted: true, fillerConfig: { fillerListIds: ['8f3c1b2a-0000-4000-8000-000000000001'] } },
    { type: 'redirect', channel: 'ch-2', channelNumber: 2, channelName: 'Two', duration: 900000, persisted: true },
    { type: 'custom', id: 'p3', customShowId: 'cs-1', index: 4, duration: 1200000, persisted: true },
    { type: 'filler', id: '8f3c1b2a-0000-4000-8000-000000000002', fillerListId: '8f3c1b2a-0000-4000-8000-000000000001', fillerType: 'pre', duration: 30000 },
  ];
  const loadedVersion = programmingVersion(lineup, undefined);
  const post = (data: unknown, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({
    method: 'POST',
    url: '/api/tunarr/channels/abc/programming',
    headers: { host: 'lineup.local:3000', origin: 'http://lineup.local:3000', 'content-type': 'application/json', 'if-match': `"${loadedVersion}"`, ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
  /** Tunarr answers GETs with the current lineup and POSTs with `postReply`. */
  const tunarr = (postReply: () => Response = () => jsonResponse({ lineup, programs: {} }), current: unknown = { lineup, programs: {} }) =>
    (_url: string, init: RequestInit) => (init.method === 'POST' ? postReply() : jsonResponse(current));

  it('forwards the manual payload with every lineup field intact', async () => {
    const { calls, config } = setup(tunarr());
    const response = await handleTunarrApi(post({ type: 'manual', lineup, append: false }), config);
    expect(response.status).toBe(200);
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST']);
    expect(calls[1].url).toBe('http://tunarr:8000/api/channels/abc/programming');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ type: 'manual', lineup, append: false });
    expect(calls[1].init.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' });
  });

  it('refuses to save when the channel changed since it was loaded', async () => {
    const changed = [...lineup].reverse();
    const { calls, config } = setup(tunarr(undefined, { lineup: changed, programs: {} }));
    const response = await handleTunarrApi(post({ type: 'manual', lineup, append: false }), config);
    expect(response.status).toBe(412);
    expect(body(response).error.code).toBe('lineup_changed');
    expect(calls.map((call) => call.init.method)).toEqual(['GET']);
  });

  it('requires the version a save is based on', async () => {
    const { fetchImpl, config } = setup(tunarr());
    const response = await handleTunarrApi(post({ type: 'manual', lineup, append: false }, { 'if-match': undefined }), config);
    expect(response.status).toBe(428);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serializes concurrent saves to one channel so only the first wins', async () => {
    let current: unknown = { lineup, programs: {} };
    const { calls, config } = setup((_url, init) => {
      if (init.method === 'POST') current = { lineup: JSON.parse(String(init.body)).lineup, programs: {} };
      return jsonResponse(current);
    });
    const reordered = [lineup[1], lineup[0], ...lineup.slice(2)];
    const [first, second] = await Promise.all([
      handleTunarrApi(post({ type: 'manual', lineup: reordered, append: false }), config),
      handleTunarrApi(post({ type: 'manual', lineup: [...lineup].reverse(), append: false }), config),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(412);
    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('passes Tunarr validation messages back', async () => {
    const { config } = setup(tunarr(() => new Response('"body/lineup/0/duration Number must be greater than 0"', { status: 400 })));
    const response = await handleTunarrApi(post({ type: 'manual', lineup, append: false }), config);
    expect(response.status).toBe(400);
    expect(body(response).error).toMatchObject({ code: 'tunarr_rejected', message: 'body/lineup/0/duration Number must be greater than 0' });
  });

  it.each([
    [{ type: 'random', schedule: { slots: [] }, seed: 'x' }, 'invalid_programming'],
    [{ type: 'manual', lineup, append: true }, 'invalid_programming'],
    [{ type: 'manual', lineup: 'nope' }, 'invalid_programming'],
    [{ type: 'manual', lineup: [{ type: 'content', duration: 1000 }] }, 'invalid_programming'],
    [{ type: 'manual', lineup: [{ type: 'content', id: 'x', duration: 0 }] }, 'invalid_programming'],
    [{ type: 'manual', lineup: [{ type: 'program', id: 'x', duration: 10 }] }, 'invalid_programming'],
    ['{not json', 'invalid_json'],
  ])('rejects invalid body %#', async (data, code) => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi(post(data), config);
    expect(response.status).toBe(400);
    expect(body(response).error.code).toBe(code);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a JSON content type', async () => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi(post({ type: 'manual', lineup }, { 'content-type': 'text/plain' }), config);
    expect(response.status).toBe(415);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks cross-origin writes', async () => {
    const { fetchImpl, config } = setup(() => jsonResponse({}));
    const response = await handleTunarrApi(post({ type: 'manual', lineup }, { origin: 'https://evil.example' }), config);
    expect(response.status).toBe(403);
    expect(body(response).error.code).toBe('cross_origin_blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('over real HTTP', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const listen = (server: http.Server) => new Promise<number>((resolve) => {
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  it('never forwards browser cookies or authorization headers to Tunarr', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const tunarrPort = await listen(http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'tunarr=1' });
      res.end(JSON.stringify(channels));
    }));
    const config = createProxyConfig({ TUNARR_URL: `http://127.0.0.1:${tunarrPort}` });
    const appPort = await listen(http.createServer((req, res) => void handleNodeApiRequest(req, res, config)));

    const response = await fetch(`http://127.0.0.1:${appPort}/api/tunarr/channels`, {
      headers: { cookie: 'session=abc', authorization: 'Bearer browser-token', 'x-forwarded-for': '10.0.0.9', connection: 'keep-alive' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(channels);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].cookie).toBeUndefined();
    expect(seen[0].authorization).toBeUndefined();
    expect(seen[0]['x-forwarded-for']).toBeUndefined();
  });

  it('passes PUT bodies through the Node adapter', async () => {
    const seen: Array<{ method?: string; body: string }> = [];
    const tunarrPort = await listen(http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a' }));
      });
    }));
    const config = createProxyConfig({ TUNARR_URL: `http://127.0.0.1:${tunarrPort}` });
    const appPort = await listen(http.createServer((req, res) => void handleNodeApiRequest(req, res, config)));
    const response = await fetch(`http://127.0.0.1:${appPort}/api/tunarr/filler-lists/0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: 'PUT', body: JSON.stringify({ name: 'Renamed' }) }]);
  });

  it('rejects oversized request bodies', async () => {
    const config = createProxyConfig({ TUNARR_URL: 'http://127.0.0.1:9' });
    const appPort = await listen(http.createServer((req, res) => void handleNodeApiRequest(req, res, config)));
    const response = await fetch(`http://127.0.0.1:${appPort}/api/tunarr/channels/abc/programming`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(21 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });
});

describe('program artwork', () => {
  const programId = '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const image = (type = 'image/png', bytes: Uint8Array = png) => new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': type } });

  it('passes image bytes through from Tunarr’s artwork route with fallbacks', async () => {
    const { calls, config } = setup(() => image());
    const response = await handleTunarrApi(get(`/api/tunarr/programs/${programId}/artwork/thumbnail`), config);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.body).toEqual(png);
    expect(calls[0].url).toBe(`http://tunarr:8000/api/programs/${programId}/artwork/thumbnail?fallbackArtworkTypes=poster%2Clandscape%2Cbanner`);
    expect((calls[0].init.headers as Record<string, string>).accept).toBe('image/*');
  });

  it.each([
    ['/api/tunarr/programs/not-a-uuid/artwork/poster', 'invalid_parameter'],
    [`/api/tunarr/programs/${programId}/artwork/fanart`, 'invalid_parameter'],
    [`/api/tunarr/programs/${programId}/artwork/poster?url=http://evil.example`, 'invalid_query'],
  ])('rejects %s', async (url, code) => {
    const { fetchImpl, config } = setup(() => image());
    const response = await handleTunarrApi(get(url), config);
    expect(response.status).toBe(400);
    expect(body(response).error.code).toBe(code);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses non-image and oversized responses', async () => {
    const html = setup(() => image('text/html'));
    expect((await handleTunarrApi(get(`/api/tunarr/programs/${programId}/artwork/poster`), html.config)).status).toBe(502);
    const huge = setup(() => image('image/jpeg', new Uint8Array(8 * 1024 * 1024 + 1)));
    const response = await handleTunarrApi(get(`/api/tunarr/programs/${programId}/artwork/poster`), huge.config);
    expect(response.status).toBe(502);
    expect(body(response).error.code).toBe('artwork_too_large');
  });

  it('maps missing artwork to 404 and does not follow redirects', async () => {
    const missing = setup(() => new Response(null, { status: 404 }));
    expect((await handleTunarrApi(get(`/api/tunarr/programs/${programId}/artwork/poster`), missing.config)).status).toBe(404);
    const redirect = setup(() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:32400/thumb' } }));
    expect((await handleTunarrApi(get(`/api/tunarr/programs/${programId}/artwork/poster`), redirect.config)).status).toBe(502);
  });

  it('only allows GET', async () => {
    const { config } = setup(() => image());
    expect((await handleTunarrApi({ ...get(`/api/tunarr/programs/${programId}/artwork/poster`), method: 'POST' }, config)).status).toBe(405);
  });
});
