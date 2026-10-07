import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createLineupServer } from '../server/app';
import { libraryEntries, validateFromLibrary } from '../server/content';
import { createFillerRoleStore } from '../server/fillerRoleStore';
import { folderRole } from '../server/fillerRoles';
import { roleLibraries } from '../server/lineupRoutes';
import { createMediaFolder, createMediaFolderAt, mediaFileName } from '../server/mediaFolder';
import { planUpload } from '../server/nodeAdapter';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

const SOURCE = 'fb9b2110-d086-49b3-997c-9873de64ef75';
const LIBRARY = '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a';
const LIST = '5e5e5e5e-1a2b-4c3d-8e9f-000000000009';
const id = (n: number) => `4d4d4d4d-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lineup-media-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

const bytes = (text: string) => Readable.from([Buffer.from(text)]);

describe('media file names', () => {
  it('accepts plain video names', () => {
    expect(mediaFileName('Station ID 1990.mp4')).toBe('Station ID 1990.mp4');
    expect(mediaFileName('ad.MKV')).toBe('ad.MKV');
  });
  it('refuses paths, hidden files, odd characters and non-videos', () => {
    for (const bad of ['../x.mp4', 'a/b.mp4', 'a\\b.mp4', '.hidden.mp4', 'notes.txt', 'x.mp4 ', 'x.', 'a:b.mp4', 'nul\u0000.mp4', '', 'x'.repeat(201) + '.mp4', 42]) {
      expect(mediaFileName(bad)).toBeNull();
    }
  });
});

describe('media folder settings', () => {
  it('is off unless LINEUP_MEDIA_DIR is set', () => {
    expect(createMediaFolder({})).toBeUndefined();
  });
  it('maps role folders to where Tunarr sees them', () => {
    const folder = createMediaFolder({ LINEUP_MEDIA_DIR: '/srv/lineup-media', LINEUP_MEDIA_TUNARR_DIR: '/media/lineup', LINEUP_MEDIA_MAX_MB: '10' });
    if (!folder || 'off' in folder) throw new Error('expected a folder');
    expect(folder.tunarrPath('station-id')).toBe('/media/lineup/station-ids');
    expect(folder.tunarrPath('other')).toBe('/media/lineup/other-filler');
    expect(folder.maxBytes).toBe(10 * 1024 * 1024);
    expect(createMediaFolder({ LINEUP_MEDIA_DIR: '/srv/x', LINEUP_MEDIA_TUNARR_DIR: 'relative' })).toHaveProperty('off');
  });
});

describe('media folder storage', () => {
  it('saves, lists, moves and deletes files without overwriting', async () => {
    const root = await tempDir();
    const media = createMediaFolderAt(root, '/media/lineup', 1024);
    await media.save('commercials', 'Soda.mp4', bytes('soda'), 4);
    expect(await readFile(path.join(root, 'commercials', 'Soda.mp4'), 'utf8')).toBe('soda');
    await expect(media.save('commercials', 'Soda.mp4', bytes('more'), 4)).rejects.toMatchObject({ status: 409 });
    expect((await media.list()).commercials.map((file) => file.name)).toEqual(['Soda.mp4']);

    await media.save('station-id', 'Soda.mp4', bytes('id'), 2);
    await expect(media.move('commercials', 'Soda.mp4', 'station-id')).rejects.toMatchObject({ status: 409 });
    await media.move('commercials', 'Soda.mp4', 'promos');
    const listed = await media.list();
    expect(listed.commercials).toEqual([]);
    expect(listed.promos.map((file) => file.name)).toEqual(['Soda.mp4']);

    await media.remove('promos', 'Soda.mp4');
    await expect(media.remove('promos', 'Soda.mp4')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses files over the limit and keeps nothing from a short upload', async () => {
    const root = await tempDir();
    const media = createMediaFolderAt(root, '/media/lineup', 8);
    await expect(media.save('bumpers', 'big.mp4', bytes('123456789'), 9)).rejects.toMatchObject({ status: 413 });
    await expect(media.save('bumpers', 'short.mp4', bytes('123'), 6)).rejects.toMatchObject({ code: 'upload_incomplete' });
    expect(await readdir(path.join(root, 'bumpers'))).toEqual([]);
  });

  it('lists only video files', async () => {
    const root = await tempDir();
    await mkdir(path.join(root, 'promos'));
    await writeFile(path.join(root, 'promos', 'notes.txt'), 'x');
    await writeFile(path.join(root, 'promos', '.upload-1.part'), 'x');
    await writeFile(path.join(root, 'promos', 'Next.mov'), 'x');
    expect((await createMediaFolderAt(root, '/m', 10).list()).promos.map((file) => file.name)).toEqual(['Next.mov']);
  });
});

describe('upload checks', () => {
  const config = (dir = '/srv/lineup-media') => createProxyConfig({ LINEUP_MEDIA_DIR: dir, LINEUP_MEDIA_MAX_MB: '1' });
  const headers = { host: 'lineup.local', 'content-type': 'application/octet-stream', 'content-length': '10' };
  const status = (result: ReturnType<typeof planUpload>) => ('status' in result ? result.status : 'ok');

  it('plans a valid upload', () => {
    expect(planUpload('/api/tunarr/media-folder/commercials/Soda%20Ad.mp4', headers, config())).toMatchObject({ role: 'commercials', file: 'Soda Ad.mp4', length: 10 });
  });
  it('refuses everything else before reading the body', () => {
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4', headers, createProxyConfig({})))).toBe(503);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4', { ...headers, origin: 'http://evil.example' }, config()))).toBe(403);
    expect(status(planUpload('/api/tunarr/media-folder/ads/a.mp4', headers, config()))).toBe(400);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/..%2Fa.mp4', headers, config()))).toBe(400);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.exe', headers, config()))).toBe(400);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4?x=1', headers, config()))).toBe(400);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4', { ...headers, 'content-type': 'text/html' }, config()))).toBe(415);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4', { ...headers, 'content-length': undefined }, config()))).toBe(411);
    expect(status(planUpload('/api/tunarr/media-folder/commercials/a.mp4', { ...headers, 'content-length': String(2 * 1024 * 1024) }, config()))).toBe(413);
    expect(status(planUpload('/api/tunarr/media-folder/connect', headers, config()))).toBe(405);
  });
});

describe('media folder over HTTP', () => {
  const servers: http.Server[] = [];
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); });

  it('uploads, lists, moves and deletes through the companion', async () => {
    const media = await tempDir();
    const server = createLineupServer({ config: createProxyConfig({ LINEUP_MEDIA_DIR: media, LINEUP_DATA_DIR: await tempDir() }), auth: null, staticRoot: await tempDir() });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tunarr/media-folder`;

    const put = await fetch(`${base}/station-id/Top%20of%20hour.mp4`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'video-bytes' });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({ role: 'station-id', name: 'Top of hour.mp4', size: 11 });
    expect((await fetch(`${base}/station-id/Top%20of%20hour.mp4`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: 'again' })).status).toBe(409);

    const listed = (await (await fetch(base)).json()) as { enabled: boolean; tunarrError?: string; folders: Array<{ role: string; files: Array<{ name: string }> }> };
    expect(listed.enabled).toBe(true);
    expect(listed.tunarrError).toMatch(/TUNARR_URL/);
    expect(listed.folders.find((folder) => folder.role === 'station-id')?.files[0].name).toBe('Top of hour.mp4');

    const moved = await fetch(`${base}/station-id/Top%20of%20hour.mp4/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'bumpers' }) });
    expect(moved.status).toBe(200);
    expect(await readdir(path.join(media, 'bumpers'))).toEqual(['Top of hour.mp4']);
    expect((await fetch(`${base}/bumpers/Top%20of%20hour.mp4`, { method: 'DELETE' })).status).toBe(200);
    expect(await readdir(path.join(media, 'bumpers'))).toEqual([]);
  });
});

type Call = { url: string; method: string; body?: unknown };
function harness(env: Record<string, string>, reply: (url: string, method: string, body: unknown) => unknown) {
  const calls: Call[] = [];
  const config: ProxyConfig = {
    ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000', ...env }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('http://tunarr:8000', '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const data = reply(url, method, body);
      if (data && typeof data === 'object' && '__status' in data) return new Response('', { status: (data as { __status: number }).__status });
      return data === undefined ? new Response(null, { status: 204 }) : Response.json(data);
    }) as typeof fetch,
  };
  return { calls, config };
}
const post = (route: string, body: unknown): ProxyRequest => ({ method: 'POST', url: `/api/tunarr${route}`, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const parse = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

describe('picking up filler folders automatically', () => {
  const SCANNED = 1_000;
  // A stateful Tunarr: sources with libraries, a search that reads `files`, and filler lists.
  function tunarr(env: Record<string, string>, initial: Array<{ id: string; type: string; name: string; libraries: Array<Record<string, unknown>> }> = []) {
    const sources = structuredClone(initial);
    const files: Record<string, number> = {};
    const lists = new Map<string, unknown[]>();
    let next = 0;
    const harnessed = harness(env, (url, method, body) => {
      const request = body as Record<string, unknown>;
      if (url === '/api/media-sources' && method === 'POST') {
        const id = `fb9b2110-d086-49b3-997c-${String(++next).padStart(12, '0')}`;
        sources.push({ id, type: 'local', name: String(request.name), libraries: (request.paths as string[]).map((externalKey, index) => ({ id: id.replace('fb9b2110', `${index}0000000`.slice(0, 8)), externalKey, name: externalKey, enabled: true, lastScannedAt: SCANNED })) });
        return { id };
      }
      if (url === '/api/media-sources') return sources;
      if (url === '/api/programs/search') {
        const count = files[String(request.libraryId)] ?? 0;
        return { results: Array.from({ length: count }, (_, index) => ({ uuid: id(index + 1), type: 'other_video', duration: 10_000 })), totalHits: count };
      }
      if (url === '/api/filler-lists' && method === 'POST') {
        const listId = `5e5e5e5e-1a2b-4c3d-8e9f-${String(++next).padStart(12, '0')}`;
        lists.set(listId, request.programs as unknown[]);
        return { id: listId };
      }
      const list = /^\/api\/filler-lists\/(.+)$/.exec(url);
      if (list && method === 'PUT') {
        if (!lists.has(list[1])) return { __status: 404 };
        lists.set(list[1], request.programs as unknown[]);
        return {};
      }
    });
    return { ...harnessed, sources, files, lists };
  }
  const sync = async (config: ProxyConfig) => parse(await handleTunarrApi(post('/filler-folders/sync', {}), config));

  it('adds the upload folder to Tunarr once and makes a list for each role folder with videos', async () => {
    const media = await tempDir();
    const fake = tunarr({ LINEUP_MEDIA_DIR: media, LINEUP_MEDIA_TUNARR_DIR: '/media/lineup', LINEUP_DATA_DIR: await tempDir() });
    const first = await sync(fake.config);
    expect(first).toMatchObject({ connected: true, created: [], errors: [] });
    expect(fake.calls.find((call) => call.method === 'POST' && call.url === '/api/media-sources')?.body).toMatchObject({ type: 'local', mediaType: 'other_videos', paths: ['/media/lineup/station-ids', '/media/lineup/commercials', '/media/lineup/promos', '/media/lineup/bumpers', '/media/lineup/other-filler'] });
    expect(await readdir(media)).toHaveLength(5);

    const searches = () => fake.calls.filter((call) => call.url === '/api/programs/search').length;
    const before = searches();
    expect((await sync(fake.config)).connected).toBe(false);
    expect(searches()).toBe(before); // empty folders aren't re-read until a new scan

    const ids = fake.sources[0].libraries.find((library) => library.externalKey === '/media/lineup/station-ids')!;
    fake.files[ids.id as string] = 2;
    ids.lastScannedAt = SCANNED + 1;
    const second = await sync(fake.config);
    expect(second.created).toEqual([expect.objectContaining({ name: 'Station IDs (folder)', count: 2, role: 'station-id' })]);
    expect(fake.calls.filter((call) => call.method === 'POST' && call.url === '/api/media-sources')).toHaveLength(1);
  });

  it('picks up Tunarr libraries named for a role, and folders added with one', async () => {
    const data = await tempDir();
    const fake = tunarr({ LINEUP_DATA_DIR: data }, [
      { id: SOURCE, type: 'plex', name: 'Plex', libraries: [
        { id: id(91), name: 'Commercials', enabled: true, lastScannedAt: SCANNED },
        { id: id(92), name: 'Accidents', enabled: true, lastScannedAt: SCANNED },
        { id: id(93), name: 'Station IDs', enabled: false, lastScannedAt: SCANNED },
      ] },
    ]);
    fake.files[id(91)] = 3;
    fake.files[id(92)] = 3;
    fake.files[id(93)] = 3;
    const result = await sync(fake.config);
    expect(result.created).toEqual([expect.objectContaining({ name: 'Commercials – Commercials', role: 'commercials', count: 3 })]);

    const added = await handleTunarrApi(post('/filler-folders/add', { path: '/media/my-spots', role: 'promos' }), fake.config);
    expect(added.status).toBe(201);
    expect(await handleTunarrApi(post('/filler-folders/add', { path: 'relative', role: 'promos' }), fake.config)).toMatchObject({ status: 400 });
    const folder = fake.sources.at(-1)!.libraries[0];
    fake.files[folder.id as string] = 1;
    expect((await sync(fake.config)).created).toEqual([expect.objectContaining({ name: 'Promos – my-spots', role: 'promos', count: 1 })]);
    expect((await createFillerRoleStore(data).folders()).pending).toEqual({});
  });

  it('follows a list after each newer scan, and lets a deleted list stay deleted', async () => {
    const data = await tempDir();
    const fake = tunarr({ LINEUP_DATA_DIR: data }, [{ id: SOURCE, type: 'local', name: 'Ads', libraries: [{ id: LIBRARY, name: '/media/commercials', enabled: true, lastScannedAt: SCANNED }] }]);
    fake.files[LIBRARY] = 1;
    const [made] = (await sync(fake.config)).created;
    expect((await sync(fake.config)).updated).toEqual([]); // nothing new since the list was read

    fake.files[LIBRARY] = 4;
    fake.sources[0].libraries[0].lastScannedAt = Date.now() + 60_000;
    expect((await sync(fake.config)).updated).toEqual([{ id: made.id, count: 4 }]);
    expect(fake.lists.get(made.id)).toHaveLength(4);

    fake.lists.delete(made.id);
    fake.sources[0].libraries[0].lastScannedAt = Date.now() + 120_000;
    const after = await sync(fake.config);
    expect(after).toMatchObject({ created: [], updated: [], errors: [] });
    expect((await createFillerRoleStore(data).folders()).ignored).toEqual([LIBRARY]);
    expect((await sync(fake.config)).created).toEqual([]);
  });

  it('finds each role folder’s library by path', () => {
    const folder = createMediaFolderAt('/srv/x', '/media/lineup', 1);
    const found = roleLibraries([
      { id: SOURCE, type: 'plex', libraries: [{ id: id(9), externalKey: '/media/lineup/commercials' }] },
      { id: SOURCE, type: 'local', libraries: [{ id: id(1), externalKey: '/media/lineup/commercials', lastScannedAt: 5, isLocked: true }, { id: id(2), externalKey: '/elsewhere' }] },
    ], folder);
    expect(found).toEqual({ commercials: { mediaSourceId: SOURCE, libraryId: id(1), lastScannedAt: 5, scanning: true } });
  });

  it('only takes plainly named folders for a role', () => {
    expect(['Commercials', '/media/station-ids', 'Station IDs', 'Promos 2024', '/srv/Bumpers', '/media/lineup/other-filler', 'Accidents', 'Kids', 'TV Shows', 'Movies'].map(folderRole))
      .toEqual(['commercials', 'station-id', 'station-id', 'promos', 'bumpers', 'other', undefined, undefined, undefined, undefined]);
  });
});

describe('filler lists from a folder', () => {
  const programs = Array.from({ length: 130 }, (_, index) => ({ uuid: id(index + 1), type: 'other_video', title: `Spot ${index}`, duration: 30_000 }));
  const search = (body: { page: number; limit: number }) => ({ results: programs.slice(body.page * body.limit, (body.page + 1) * body.limit), totalHits: programs.length });

  it('validates the request', () => {
    expect(validateFromLibrary({ mediaSourceId: SOURCE, libraryId: LIBRARY, name: 'Ads' })).toMatchObject({ name: 'Ads' });
    expect(validateFromLibrary({ mediaSourceId: SOURCE, libraryId: LIBRARY })).toHaveProperty('error');
    expect(validateFromLibrary({ mediaSourceId: SOURCE, libraryId: 'x', name: 'Ads' })).toHaveProperty('error');
    expect(validateFromLibrary({ mediaSourceId: SOURCE, libraryId: LIBRARY, name: 'Ads', role: 'ads' })).toHaveProperty('error');
  });

  it('keeps only playable items, as full programs', () => {
    expect(libraryEntries([{ uuid: id(1), type: 'show', duration: 5 }, { uuid: id(2), type: 'other_video', duration: 0 }, { uuid: 'x', duration: 5 }, { uuid: id(3), type: 'movie', duration: 7 }]))
      .toEqual([{ type: 'content', id: id(3), duration: 7, program: { uuid: id(3), type: 'movie', duration: 7 } }]);
  });

  it('reads every page, creates the list, and stores its role and folder', async () => {
    const data = await tempDir();
    const { calls, config } = harness({ LINEUP_DATA_DIR: data }, (url, method, body) => {
      if (url === '/api/programs/search') return search(body as { page: number; limit: number });
      if (url === '/api/filler-lists' && method === 'POST') return { id: LIST };
    });
    const response = await handleTunarrApi(post('/filler-lists/from-library', { mediaSourceId: SOURCE, libraryId: LIBRARY, name: 'Station IDs (folder)', role: 'station-id' }), config);
    expect(response.status).toBe(201);
    expect(parse(response)).toEqual({ id: LIST, count: 130 });
    expect(calls.filter((call) => call.url === '/api/programs/search').map((call) => (call.body as { page: number }).page)).toEqual([0, 1]);
    const created = calls.find((call) => call.url === '/api/filler-lists')!.body as { name: string; programs: unknown[] };
    expect(created.name).toBe('Station IDs (folder)');
    expect(created.programs).toHaveLength(130);
    const store = createFillerRoleStore(data);
    expect(await store.list()).toEqual({ [LIST]: 'station-id' });
    expect(await store.links()).toEqual({ [LIST]: { mediaSourceId: SOURCE, libraryId: LIBRARY, builtAt: expect.any(Number) } });
  });

  it('replaces a linked list’s programs and keeps its name', async () => {
    const { calls, config } = harness({ LINEUP_DATA_DIR: await tempDir() }, (url, method, body) => {
      if (url === '/api/programs/search') return search(body as { page: number; limit: number });
      if (method === 'PUT') return {};
    });
    const response = await handleTunarrApi(post('/filler-lists/from-library', { mediaSourceId: SOURCE, libraryId: LIBRARY, listId: LIST }), config);
    expect(response.status).toBe(200);
    const update = calls.find((call) => call.method === 'PUT')!;
    expect(update.url).toBe(`/api/filler-lists/${LIST}`);
    expect(Object.keys(update.body as object)).toEqual(['programs']);
  });

  it('says so when Tunarr has found nothing yet', async () => {
    const { calls, config } = harness({ LINEUP_DATA_DIR: await tempDir() }, (url) => (url === '/api/programs/search' ? { results: [], totalHits: 0 } : undefined));
    const response = await handleTunarrApi(post('/filler-lists/from-library', { mediaSourceId: SOURCE, libraryId: LIBRARY, name: 'Ads' }), config);
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.url === '/api/filler-lists')).toBe(false);
  });
});

describe('filler links in the role store', () => {
  it('keeps roles and links side by side, one list per folder', async () => {
    const store = createFillerRoleStore(await tempDir());
    await store.set(LIST, 'commercials');
    await store.link(LIST, { mediaSourceId: SOURCE, libraryId: LIBRARY });
    const other = '5e5e5e5e-1a2b-4c3d-8e9f-000000000010';
    await store.link(other, { mediaSourceId: SOURCE, libraryId: LIBRARY });
    expect(await store.links()).toEqual({ [other]: { mediaSourceId: SOURCE, libraryId: LIBRARY } });
    expect(await store.list()).toEqual({ [LIST]: 'commercials' });
  });
});
