// Large channels on the companion: slim programming, the short shared cache and
// its invalidation, ETag revalidation, and response compression (server/programmingCache.ts,
// server/compression.ts). The synthetic channel is shaped like Tunarr's real reply.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { syntheticProgramming } from '../e2e/syntheticChannel.mjs';
import { createLineupServer } from '../server/app';
import { withChannelLock } from '../server/channelLock';
import { pickEncoding } from '../server/compression';
import { slimPrograms } from '../server/lineupItems';
import { programmingVersion } from '../server/lineupVersion';
import { bodyEtag, createProgrammingCache, etagMatches, slimProgramming, toView } from '../server/programmingCache';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';
import { testDataDir } from './tempData';

const CHANNEL = 'f6a4c3d2-1111-4222-8333-944455556666';
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const get = (url: string, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local:3000', ...headers } });

/** A proxy config over a fake Tunarr whose programming can change between calls. */
function upstream(env: Record<string, string> = {}) {
  const state = { lineup: [{ type: 'content', id: 'p1', duration: 60_000 }] as Array<Record<string, unknown>>, gets: 0, gate: null as Promise<void> | null };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET' && String(input).endsWith('/programming')) {
      state.gets += 1;
      if (state.gate) await state.gate;
      return jsonResponse({ lineup: state.lineup, programs: { p1: { type: 'content', id: 'p1', program: { title: 'One', type: 'movie' } }, p2: { type: 'content', id: 'p2', program: { title: 'Two', type: 'movie' } } } });
    }
    if (init?.method === 'POST') {
      state.lineup = (JSON.parse(String(init.body)) as { lineup: Array<Record<string, unknown>> }).lineup;
      return jsonResponse({ lineup: state.lineup, programs: {} });
    }
    return jsonResponse({});
  });
  const config: ProxyConfig = { ...createProxyConfig({ LINEUP_DATA_DIR: testDataDir, TUNARR_URL: 'http://tunarr:8000', ...env }), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { state, config };
}

describe('slim programming', () => {
  it('keeps the lineup, schedule and version exactly, and only titles of programs', () => {
    const { programming } = syntheticProgramming({ items: 300 });
    const schedule = { type: 'time', slots: [] };
    const slim = slimProgramming({ ...programming, schedule });
    expect(slim.lineup).toBe(programming.lineup);
    expect(slim.schedule).toBe(schedule);
    expect(programmingVersion(slim.lineup, slim.schedule)).toBe(programmingVersion(programming.lineup, schedule));
    expect(slim).not.toHaveProperty('startTimeOffsets');
    const [id, entry] = Object.entries(slim.programs as Record<string, Record<string, unknown>>)[0];
    expect(Object.keys(entry).sort()).toEqual(['episodeNumber', 'seasonNumber', 'show', 'title', 'type', 'year']);
    expect(JSON.stringify(entry)).not.toMatch(/X-Plex-Token|32400|summary/);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps an entry for every program the lineup plays, however many there are', () => {
    // More than slimPrograms' default cap of 20,000, which would flag the rest as missing in the lineup check.
    const lineup = Array.from({ length: 25_000 }, (_, index) => ({ type: 'content', id: `p-${index}`, duration: 60_000 }));
    const programs = Object.fromEntries(lineup.map((item) => [item.id, { type: 'content', id: item.id, program: { title: item.id, type: 'movie' } }]));
    expect(Object.keys(slimProgramming({ lineup, programs }).programs as object)).toHaveLength(25_000);
  });

  it('reduces a 5,000-item channel within its size and time budgets', () => {
    const { programming } = syntheticProgramming({ items: 5_000 });
    const raw = JSON.stringify(programming);
    const started = performance.now();
    const view = toView(programming);
    const elapsed = performance.now() - started;
    const wire = gzipSync(view.body).byteLength;
    console.log(`[perf] ${JSON.stringify({ scenario: 'server-slim-5000', rawBytes: raw.length, slimBytes: view.body.length, gzipBytes: wire, ms: Math.round(elapsed) })}`);
    expect(view.body.length).toBeLessThan(raw.length * 0.4);
    expect(wire).toBeLessThan(150_000);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('counts programs in linear time (20,000 items)', () => {
    const { programming } = syntheticProgramming({ items: 20_000 });
    const started = performance.now();
    slimPrograms(programming.lineup, programming.programs, 100_000);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('ETags', () => {
  it('matches If-None-Match the way browsers and proxies send it', () => {
    const etag = bodyEtag('{"lineup":[]}');
    expect(etag).toMatch(/^W\/"/);
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(etag.slice(2), etag)).toBe(true);
    expect(etagMatches(`W/"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('W/"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });

  it('answers 304 without a body when the browser already has this programming', async () => {
    const { config } = upstream();
    const first = await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/programming`), config);
    const again = await handleTunarrApi(get(`/api/tunarr/channels/${CHANNEL}/programming`, { 'if-none-match': first.headers.etag }), config);
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(first.headers.etag);
  });
});

describe('programming cache', () => {
  it('shares one Tunarr read between requests for the same channel', async () => {
    let release!: () => void;
    const load = vi.fn(() => new Promise<unknown>((resolve) => { release = () => resolve({ lineup: [] }); }));
    const cache = createProgrammingCache(0);
    const reads = [cache.get('a', load), cache.get('a', load)];
    release();
    const [one, two] = await Promise.all(reads);
    expect(load).toHaveBeenCalledTimes(1);
    expect([one.source, two.source]).toEqual(['tunarr', 'shared']);
  });

  it('reuses a result for its time to live only', async () => {
    let now = 1_000;
    const load = vi.fn(async () => ({ lineup: [] }));
    const cache = createProgrammingCache(3_000, () => now);
    await cache.get('a', load);
    now += 2_999;
    expect((await cache.get('a', load)).source).toBe('cache');
    now += 1;
    expect((await cache.get('a', load)).source).toBe('tunarr');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops a channel’s cached programming when a Lineup write to it runs', async () => {
    const load = vi.fn(async () => ({ lineup: [] }));
    const cache = createProgrammingCache(60_000);
    await cache.get('written', load);
    await withChannelLock('written', async () => undefined);
    expect((await cache.get('written', load)).source).toBe('tunarr');
    // Other channels keep theirs.
    await cache.get('other', load);
    await withChannelLock('written', async () => undefined);
    expect((await cache.get('other', load)).source).toBe('cache');
  });

  it('never keeps a read that was in flight when a write started', async () => {
    let release!: () => void;
    const slow = () => new Promise<unknown>((resolve) => { release = () => resolve({ lineup: [{ id: 'before' }] }); });
    const cache = createProgrammingCache(60_000);
    const read = cache.get('racing', slow);
    await withChannelLock('racing', async () => undefined);
    release();
    await read;
    const fresh = vi.fn(async () => ({ lineup: [{ id: 'after' }] }));
    const next = await cache.get('racing', fresh);
    expect(next.source).toBe('tunarr');
    expect(next.view.body).toContain('after');
  });

  it('doesn’t keep failures', async () => {
    const cache = createProgrammingCache(60_000);
    await expect(cache.get('a', async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect((await cache.get('a', async () => ({ lineup: [] }))).source).toBe('tunarr');
  });

  it('shows a Lineup save at once, never the lineup from before it, even with the cache on', async () => {
    const { state, config } = upstream({ LINEUP_PROGRAMMING_CACHE_MS: '60000' });
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    const before = await handleTunarrApi(get(url), config);
    const version = programmingVersion(state.lineup, undefined);
    const saved = await handleTunarrApi({ method: 'POST', url, headers: { host: 'lineup.local:3000', 'content-type': 'application/json', 'if-match': `"${version}"` }, body: JSON.stringify({ type: 'manual', lineup: [{ type: 'content', id: 'p2', duration: 60_000 }], append: false }) }, config);
    expect(saved.status).toBe(200);
    const after = await handleTunarrApi(get(url), config);
    expect(after.headers['x-lineup-source']).toBe('tunarr');
    expect(JSON.parse(String(after.body)).lineup[0].id).toBe('p2');
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('reads Tunarr again for every request by default, so outside changes show at once', async () => {
    const { state, config } = upstream();
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    const first = await handleTunarrApi(get(url), config);
    // Changed in Tunarr's own UI, not through Lineup.
    state.lineup = [{ type: 'content', id: 'p2', duration: 60_000 }];
    const second = await handleTunarrApi(get(url, { 'if-none-match': first.headers.etag }), config);
    expect(state.gets).toBe(2);
    expect(second.status).toBe(200);
    expect(JSON.parse(String(second.body)).lineup[0].id).toBe('p2');
  });

  it('still shares one Tunarr read between simultaneous requests by default', async () => {
    const { state, config } = upstream();
    let open!: () => void;
    state.gate = new Promise<void>((resolve) => { open = resolve; });
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    const both = Promise.all([handleTunarrApi(get(url), config), handleTunarrApi(get(url), config)]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    open();
    const [one, two] = await both;
    expect(state.gets).toBe(1);
    expect(one.body).toBe(two.body);
  });

  it('reuses a recent read when LINEUP_PROGRAMMING_CACHE_MS asks for it', async () => {
    const { state, config } = upstream({ LINEUP_PROGRAMMING_CACHE_MS: '5000' });
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    await handleTunarrApi(get(url), config);
    const second = await handleTunarrApi(get(url), config);
    expect(state.gets).toBe(1);
    expect(second.headers['x-lineup-source']).toBe('cache');
  });
});

describe('compression', () => {
  it('picks Brotli, then gzip, from Accept-Encoding', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding('*, br;q=0')).toBe('gzip');
    expect(pickEncoding(undefined)).toBeNull();
  });

  let root: string;
  const servers: http.Server[] = [];
  const start = async (env: Record<string, string> = {}) => {
    const { programming } = syntheticProgramming({ items: 2_000 });
    const fetchImpl = vi.fn(async () => jsonResponse(programming));
    const config = { ...createProxyConfig({ LINEUP_DATA_DIR: testDataDir, TUNARR_URL: 'http://tunarr:8000', ...env }), fetchImpl: fetchImpl as unknown as typeof fetch };
    const server = createLineupServer({ config, auth: null, staticRoot: root });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, programming };
  };
  /** A raw request (fetch would decompress and hide the headers). */
  const raw = (port: number, pathname: string, headers: Record<string, string>, method = 'GET') => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lineup-compress-'));
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Lineup</title>');
    await writeFile(path.join(root, 'assets', 'app.js'), `console.log(${JSON.stringify('x'.repeat(20_000))});`);
  });
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(root, { recursive: true, force: true });
  });

  it('gzips programming for a browser on plain HTTP and Brotli-compresses it over HTTPS', async () => {
    const { port, programming } = await start();
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    const gz = await raw(port, url, { 'accept-encoding': 'gzip, deflate' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.vary).toBe('Accept-Encoding');
    expect(JSON.parse(gunzipSync(gz.body).toString()).lineup).toEqual(programming.lineup);
    expect(Number(gz.headers['content-length'])).toBe(gz.body.byteLength);
    const br = await raw(port, url, { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.body).toString()).lineup).toHaveLength(2_000);
    const plain = await raw(port, url, {});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(br.body.byteLength).toBeLessThan(plain.body.byteLength / 5);
  });

  it('answers a revalidation with 304 and no body', async () => {
    const { port } = await start();
    const url = `/api/tunarr/channels/${CHANNEL}/programming`;
    const first = await raw(port, url, { 'accept-encoding': 'gzip' });
    const again = await raw(port, url, { 'accept-encoding': 'gzip', 'if-none-match': String(first.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.body.byteLength).toBe(0);
  });

  it('leaves small answers and LINEUP_COMPRESSION=off alone', async () => {
    const { port } = await start({ LINEUP_COMPRESSION: 'off' });
    const off = await raw(port, `/api/tunarr/channels/${CHANNEL}/programming`, { 'accept-encoding': 'gzip, br' });
    expect(off.headers['content-encoding']).toBeUndefined();
    const small = await start();
    const health = await raw(small.port, '/api/tunarr/drafts', { 'accept-encoding': 'gzip' });
    expect(health.headers['content-encoding']).toBeUndefined();
  });

  it('compresses the interface’s files, for HEAD as well', async () => {
    const { port } = await start();
    const js = await raw(port, '/assets/app.js', { 'accept-encoding': 'gzip' });
    expect(js.headers['content-encoding']).toBe('gzip');
    expect(js.headers['cache-control']).toContain('immutable');
    expect(gunzipSync(js.body).toString()).toContain('console.log');
    const head = await raw(port, '/assets/app.js', { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(head.headers['content-length']).toBe(js.headers['content-length']);
    expect(head.body.byteLength).toBe(0);
    // Too small to bother.
    const index = await raw(port, '/', { 'accept-encoding': 'gzip' });
    expect(index.headers['content-encoding']).toBeUndefined();
  });
});
