import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { artistOf, groupByArtist, spreadArtists, videoLabel } from '../lib/localVideos';
import type { ContentProgram, LibraryItem } from '../lib/library';
import { arrangePrograms } from '../lib/programBin';
import { createLineupServer } from '../server/app';
import { matchLineupRoute } from '../server/lineupRoutes';
import { createLocalVideoStore, readLocalVideoState } from '../server/localVideoStore';
import { isProgramPath } from '../server/localVideos';
import { createMediaFolderAt } from '../server/mediaFolder';
import { planUpload } from '../server/nodeAdapter';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';
import { artistKey, folderOrder, naturalCompare, parseVideoTitle, videoFolderName } from '../server/videoTitles';

const id = (n: number) => `4d4d4d4d-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;
const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lineup-videos-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });
const bytes = (text: string) => Readable.from([Buffer.from(text)]);

describe('local video titles', () => {
  it('reads the artist and a clean title from download file names', () => {
    expect(parseVideoTitle('Rick Astley - Never Gonna Give You Up (Official Music Video) [dQw4w9WgXcQ]')).toEqual({ artist: 'Rick Astley', title: 'Never Gonna Give You Up', display: 'Rick Astley – Never Gonna Give You Up' });
    expect(parseVideoTitle('a-ha – Take On Me (Official 4K Music Video)')).toMatchObject({ artist: 'a-ha', title: 'Take On Me' });
    expect(parseVideoTitle('03 - Daft Punk - Around the World [1080p].mp4')).toMatchObject({ artist: 'Daft Punk', title: 'Around the World' });
    expect(parseVideoTitle('Queen_-_Bohemian_Rhapsody')).toMatchObject({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(parseVideoTitle('Toto - Africa (Remastered 2009)-FTQbiNvZqaY')).toMatchObject({ artist: 'Toto', title: 'Africa' });
    // Meaningful brackets stay.
    expect(parseVideoTitle('Nirvana - Lithium (Live at Reading)')).toMatchObject({ title: 'Lithium (Live at Reading)' });
    expect(parseVideoTitle('Untitled Clip')).toEqual({ title: 'Untitled Clip', display: 'Untitled Clip' });
    expect(parseVideoTitle('')).toMatchObject({ title: 'Untitled' });
  });

  it('keeps episode numbers on other videos', () => {
    expect(parseVideoTitle('01 - Pilot', 'videos')).toEqual({ title: '01 - Pilot', display: '01 - Pilot' });
    expect(parseVideoTitle('Hot Ones - Season 1 Episode 2 [abcDEF12345]', 'videos')).toMatchObject({ artist: 'Hot Ones', title: 'Season 1 Episode 2' });
  });

  it('treats one artist as one, whatever the case, accents or guests', () => {
    expect(artistKey('Beyoncé feat. JAY-Z')).toBe(artistKey('beyonce'));
    expect(artistKey('The Cure')).toBe(artistKey('Cure'));
  });

  it('orders folders like a file manager, music videos by artist', () => {
    expect(['Part 10', 'Part 2', 'part 1'].sort(naturalCompare)).toEqual(['part 1', 'Part 2', 'Part 10']);
    const titles = (items: Array<{ title: string }>) => items.map((item) => item.title);
    expect(titles(folderOrder([{ title: 'Ep 10' }, { title: 'Ep 9' }], 'videos'))).toEqual(['Ep 9', 'Ep 10']);
    expect(titles(folderOrder([{ title: 'Zed - B' }, { title: 'Abba - Waterloo' }, { title: 'Zed - A' }], 'music-videos'))).toEqual(['Abba - Waterloo', 'Zed - A', 'Zed - B']);
  });

  it('accepts plain folder names only', () => {
    expect(videoFolderName(' 80s Rock ')).toBe('80s Rock');
    for (const bad of ['', '.hidden', 'a/b', 'a\\b', '..', 'x.', 'a:b', 'x'.repeat(101), 3]) expect(videoFolderName(bad)).toBeNull();
  });
});

const video = (n: number, title: string, type = 'music_video'): LibraryItem => ({ uuid: id(n), type, title, duration: 200_000 });
const program = (item: LibraryItem): ContentProgram => ({ type: 'content', id: item.uuid, duration: item.duration!, program: item });
const seeded = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

describe('music videos in the program bin', () => {
  const items = [video(1, 'Abba - Waterloo'), video(2, 'Abba - SOS'), video(3, 'Abba - Mamma Mia'), video(4, 'Blur - Song 2'), video(5, 'Blur - Parklife'), video(6, 'Cher - Believe'), video(7, 'Loose clip', 'other_video')];

  it('finds artists from Tunarr’s fields or the file name', () => {
    expect(artistOf({ type: 'music_video', title: 'x', artist: { title: 'Madonna' } })).toBe('Madonna');
    expect(artistOf({ type: 'track', title: 'x', grandparent: { title: 'Prince' } })).toBe('Prince');
    expect(artistOf(items[0])).toBe('Abba');
    expect(artistOf({ type: 'episode', title: 'Show - Episode' })).toBeUndefined();
    expect(videoLabel(video(9, 'Abba - Waterloo (Official Video)'), false)).toBe('Waterloo');
  });

  it('groups by artist, those without one last', () => {
    expect(groupByArtist(items).map((group) => [group.artist, group.items.length])).toEqual([['Abba', 3], ['Blur', 2], ['Cher', 1], ['', 1]]);
    expect(groupByArtist(items)[0].items.map((item) => videoLabel(item, false))).toEqual(['Mamma Mia', 'SOS', 'Waterloo']);
  });

  it('never airs an artist twice in a row when the mix allows, and keeps every video', () => {
    for (let seed = 1; seed < 40; seed += 1) {
      const spread = spreadArtists(items.map(program), seeded(seed), 1);
      expect(spread.map((entry) => entry.id).sort()).toEqual(items.map((item) => item.uuid).sort());
      const artists = spread.map((entry) => artistOf(entry.program) ?? entry.id);
      for (let at = 1; at < artists.length; at += 1) expect(artists[at]).not.toBe(artists[at - 1]);
    }
  });

  it('keeps artists apart across passes too', () => {
    const five = [video(1, 'Abba - Waterloo'), video(2, 'Blur - Song 2'), video(3, 'Abba - SOS'), video(4, 'Cher - Believe'), video(5, 'Loose clip', 'other_video')];
    for (let seed = 1; seed < 60; seed += 1) {
      const arranged = arrangePrograms(five.map(program), { order: 'spread', repeat: 6, after: { kind: 'none' } }, seeded(seed));
      const artists = arranged.programs.map((entry) => artistOf(entry.program) ?? entry.id);
      expect(artists).toHaveLength(30);
      for (let at = 1; at < artists.length; at += 1) expect(artists[at]).not.toBe(artists[at - 1]);
    }
  });

  it('fills a length and breaks after every few videos', () => {
    const arranged = arrangePrograms(items.map(program), { order: 'spread', repeat: 1, fill: 60 * 60_000, after: { kind: 'flex', duration: 120_000, every: 4 } }, seeded(7));
    // 200s videos and a 2-minute break after every 4th: full at an hour, the last video allowed to finish.
    const total = arranged.items.reduce((sum, item) => sum + item.duration, 0);
    expect(total).toBeGreaterThanOrEqual(60 * 60_000);
    expect(total - 200_000 - 120_000).toBeLessThan(60 * 60_000);
    expect(arranged.units.filter((unit) => unit.length === 2)).toHaveLength(Math.floor(arranged.programs.length / 4));
    expect(arranged.units[3]).toHaveLength(2);
    expect(arranged.units[0]).toHaveLength(1);
  });
});

describe('program folders in the media folder', () => {
  it('saves, lists, plays and deletes videos in named folders, never through a link', async () => {
    const root = await tempDir();
    const media = createMediaFolderAt(root, '/media/lineup', 1024);
    expect(media.programs.tunarrPath('music-videos', '80s Rock')).toBe('/media/lineup/music-videos/80s Rock');
    await expect(media.programs.save('videos', 'Concerts', 'a.mp4', bytes('x'), 1)).rejects.toMatchObject({ status: 404 });
    await media.programs.make('videos', 'Concerts');
    await media.programs.make('videos', 'Concerts');
    await media.programs.save('videos', 'Concerts', 'Live 1.mp4', bytes('live'), 4);
    await expect(media.programs.save('videos', 'Concerts', 'Live 1.mp4', bytes('more'), 4)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(root, 'videos', 'Concerts', 'Live 1.mp4'), 'utf8')).toBe('live');
    expect(await media.programs.list()).toEqual([{ kind: 'videos', folder: 'Concerts', files: [expect.objectContaining({ name: 'Live 1.mp4', size: 4 })] }]);
    expect((await media.programs.open('videos', 'Concerts', 'Live 1.mp4')).size).toBe(4);

    // A link planted where a folder should be is never followed.
    const outside = await tempDir();
    await writeFile(path.join(outside, 'secret.mp4'), 'x');
    await mkdir(path.join(root, 'music-videos'), { recursive: true });
    await symlink(outside, path.join(root, 'music-videos', 'Linked'));
    await expect(media.programs.open('music-videos', 'Linked', 'secret.mp4')).rejects.toMatchObject({ status: 404 });
    expect((await media.programs.list()).map((folder) => folder.folder)).toEqual(['Concerts']);

    await media.programs.remove('videos', 'Concerts', 'Live 1.mp4');
    expect(await readdir(path.join(root, 'videos', 'Concerts'))).toEqual([]);
  });

  it('tells program folders from other paths', () => {
    const media = createMediaFolderAt('/srv/m', '/media/lineup', 1);
    expect(isProgramPath(media, '/media/lineup/videos/Concerts')).toBe(true);
    expect(isProgramPath(media, '/media/lineup/videos')).toBe(false);
    expect(isProgramPath(media, '/media/lineup/videos2/x')).toBe(false);
    expect(isProgramPath(media, '/media/lineup/videos/a/b')).toBe(false);
    expect(isProgramPath(media, '/media/lineup/commercials')).toBe(false);
  });

  it('matches file routes and checks uploads before reading them', () => {
    expect(matchLineupRoute('/local-videos/files/music-videos/80s%20Rock/Abba%20-%20SOS.mp4')).toMatchObject({ name: 'local-video-file', kind: 'music-videos', folder: '80s Rock', file: 'Abba - SOS.mp4' });
    expect(matchLineupRoute('/local-videos/files/movies/x/a.mp4')).toHaveProperty('invalid');
    expect(matchLineupRoute('/local-videos/files/videos/..%2Fx/a.mp4')).toHaveProperty('invalid');
    expect(matchLineupRoute('/local-videos/files/videos/x/a.exe')).toHaveProperty('invalid');
    expect(matchLineupRoute('/local-videos/libraries/not-a-uuid')).toHaveProperty('invalid');
    const config = createProxyConfig({ LINEUP_MEDIA_DIR: '/srv/m' });
    const headers = { host: 'lineup.local', 'content-type': 'video/mp4', 'content-length': '5' };
    expect(planUpload('/api/tunarr/local-videos/files/videos/Concerts/a.mp4', headers, config)).toMatchObject({ kind: 'videos', folder: 'Concerts', file: 'a.mp4', length: 5 });
    expect(planUpload('/api/tunarr/local-videos/files/videos/Concerts/a.mp4', { ...headers, origin: 'http://evil.example' }, config)).toMatchObject({ status: 403 });
  });
});

describe('the local-video store', () => {
  it('remembers kinds, followed shows and folders waiting for a scan', async () => {
    const store = createLocalVideoStore(await tempDir());
    await store.setKind(id(1), 'music-videos');
    await store.addPending(id(1), { mediaSourceId: id(2), name: 'Music videos – Hits', kind: 'music-videos' });
    expect((await store.state()).pending[id(1)]).toMatchObject({ name: 'Music videos – Hits' });
    await store.follow(id(3), { mediaSourceId: id(2), libraryId: id(1), kind: 'music-videos', builtAt: 5 });
    expect(await store.state()).toEqual({ kinds: { [id(1)]: 'music-videos' }, shows: { [id(3)]: { mediaSourceId: id(2), libraryId: id(1), kind: 'music-videos', builtAt: 5 } }, pending: {} });
    // A library feeds one show.
    await store.follow(id(4), { mediaSourceId: id(2), libraryId: id(1), kind: 'music-videos' });
    expect(Object.keys((await store.state()).shows)).toEqual([id(4)]);
    await store.unfollowLibrary(id(1));
    expect((await store.state()).shows).toEqual({});
  });

  it('drops entries a hand edit broke', () => {
    expect(readLocalVideoState({ kinds: { [id(1)]: 'movies', bad: 'videos', [id(2)]: 'videos' }, shows: { [id(3)]: { libraryId: 'x' } }, pending: [] })).toEqual({ kinds: { [id(2)]: 'videos' }, shows: {}, pending: {} });
  });
});

type Call = { url: string; method: string; body?: unknown };
const SCANNED = 1_000;

/** A stateful Tunarr: local sources, a search that reads `files` (titled), custom shows and filler lists. */
function tunarr(env: Record<string, string>) {
  const calls: Call[] = [];
  const sources: Array<{ id: string; type: string; name: string; libraries: Array<Record<string, unknown>> }> = [];
  const files: Record<string, string[]> = {};
  const shows = new Map<string, unknown[]>();
  const lists = new Map<string, unknown[]>();
  let next = 0;
  const config: ProxyConfig = {
    ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000', ...env }),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('http://tunarr:8000', '');
      const method = init?.method ?? 'GET';
      const body = (init?.body ? JSON.parse(String(init.body)) : undefined) as Record<string, unknown> | undefined;
      calls.push({ url, method, body });
      const reply = (data: unknown, status = 200) => (data === undefined ? new Response(null, { status: 204 }) : Response.json(data, { status }));
      if (url === '/openapi.json') return new Response('', { status: 404 });
      if (url === '/api/media-sources' && method === 'POST') {
        const sourceId = `fb9b2110-d086-49b3-997c-${String(++next).padStart(12, '0')}`;
        sources.push({ id: sourceId, type: 'local', name: String(body!.name), libraries: (body!.paths as string[]).map((externalKey) => ({ id: `0e2d2a41-5f2f-4a7e-9d3a-${String(++next).padStart(12, '0')}`, externalKey, name: externalKey, mediaType: body!.mediaType, enabled: true })) });
        return reply({ id: sourceId });
      }
      if (url === '/api/media-sources') return reply(sources);
      if (url === '/api/programs/search') {
        const titles = files[String(body!.libraryId)] ?? [];
        return reply({ results: titles.map((title, index) => ({ uuid: id(100 + index), type: 'other_video', title, duration: 10_000 })), totalHits: titles.length });
      }
      if (url === '/api/custom-shows' && method === 'POST') {
        const showId = `5e5e5e5e-1a2b-4c3d-8e9f-${String(++next).padStart(12, '0')}`;
        shows.set(showId, body!.programs as unknown[]);
        return reply({ id: showId });
      }
      const show = /^\/api\/custom-shows\/(.+)$/.exec(url);
      if (show) {
        if (!shows.has(show[1])) return reply({ message: 'gone' }, 404);
        if (method === 'PUT') shows.set(show[1], body!.programs as unknown[]);
        return reply({ id: show[1], name: 'Show' });
      }
      if (url === '/api/filler-lists' && method === 'POST') {
        const listId = `6e6e6e6e-1a2b-4c3d-8e9f-${String(++next).padStart(12, '0')}`;
        lists.set(listId, body!.programs as unknown[]);
        return reply({ id: listId });
      }
      return reply(undefined);
    }) as typeof fetch,
  };
  return { config, calls, sources, files, shows, lists };
}
const request = (method: string, route: string, body?: unknown): ProxyRequest => ({ method, url: `/api/tunarr${route}`, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const parse = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const call = async (config: ProxyConfig, method: string, route: string, body?: unknown) => {
  const response = await handleTunarrApi(request(method, route, body), config);
  return { status: response.status, body: parse(response) };
};

describe('local videos with Tunarr', () => {
  it('makes a folder, adds it to Tunarr, and keeps a custom show of it after each scan', async () => {
    const media = await tempDir();
    const fake = tunarr({ LINEUP_MEDIA_DIR: media, LINEUP_MEDIA_TUNARR_DIR: '/media/lineup', LINEUP_DATA_DIR: await tempDir() });
    const made = await call(fake.config, 'POST', '/local-videos/folders', { kind: 'music-videos', name: 'Hits', follow: true });
    expect(made).toMatchObject({ status: 201, body: { kind: 'music-videos', folder: 'Hits' } });
    expect(await readdir(path.join(media, 'music-videos'))).toEqual(['Hits']);
    expect(fake.calls.find((entry) => entry.method === 'POST' && entry.url === '/api/media-sources')?.body).toEqual({ type: 'local', name: 'Music videos – Hits', mediaType: 'other_videos', paths: ['/media/lineup/music-videos/Hits'], pathReplacements: [] });
    expect((await call(fake.config, 'POST', '/local-videos/folders', { kind: 'music-videos', name: '../x' })).status).toBe(400);

    // Not scanned yet: nothing to make.
    expect((await call(fake.config, 'POST', '/local-videos/sync', {})).body).toMatchObject({ connected: [], created: [], errors: [] });
    const library = fake.sources[0].libraries[0];
    fake.files[library.id as string] = ['Zed - Two', 'Abba - SOS', 'Zed - One'];
    library.lastScannedAt = SCANNED;
    const first = (await call(fake.config, 'POST', '/local-videos/sync', {})).body;
    expect(first.created).toEqual([expect.objectContaining({ name: 'Music videos – Hits', count: 3 })]);
    const showId = first.created[0].id;
    // Artist order: Abba, then Zed's in title order.
    expect((fake.shows.get(showId) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([id(101), id(102), id(100)]);
    expect(fake.shows.get(showId)![0]).toEqual({ type: 'content', id: id(101), duration: 10_000 });

    const listed = (await call(fake.config, 'GET', '/local-videos')).body;
    expect(listed.media).toEqual({ enabled: true, maxBytes: expect.any(Number) });
    expect(listed.folders).toEqual([expect.objectContaining({ key: 'upload:music-videos/Hits', kind: 'music-videos', name: 'Hits', show: expect.objectContaining({ id: showId }), pending: false, upload: { area: 'music-videos', folder: 'Hits', files: [] } })]);
    expect(JSON.stringify(listed)).not.toContain('/media/lineup');

    // A newer scan refreshes the show; a deleted show stays deleted.
    fake.files[library.id as string].push('Abba - Waterloo');
    library.lastScannedAt = Date.now() + 60_000;
    expect((await call(fake.config, 'POST', '/local-videos/sync', {})).body.updated).toEqual([{ id: showId, count: 4 }]);
    fake.shows.delete(showId);
    library.lastScannedAt = Date.now() + 120_000;
    expect((await call(fake.config, 'POST', '/local-videos/sync', {})).body).toMatchObject({ created: [], updated: [], errors: [] });
    expect((await call(fake.config, 'GET', '/local-videos')).body.folders[0].show).toBeNull();
  });

  it('adds media-folder folders made while Tunarr was away, and never takes them for filler', async () => {
    const media = await tempDir();
    await mkdir(path.join(media, 'videos', 'Commercials 1985'), { recursive: true });
    const fake = tunarr({ LINEUP_MEDIA_DIR: media, LINEUP_MEDIA_TUNARR_DIR: '/media/lineup', LINEUP_DATA_DIR: await tempDir() });
    expect((await call(fake.config, 'POST', '/local-videos/sync', {})).body.connected).toEqual(['Commercials 1985']);
    const library = fake.sources.find((source) => source.name === 'Videos – Commercials 1985')!.libraries[0];
    fake.files[library.id as string] = ['Ep 2', 'Ep 10', 'Ep 1'];
    library.lastScannedAt = SCANNED;
    // The filler pickup sees a library named for commercials, but it holds programs.
    const filler = (await call(fake.config, 'POST', '/filler-folders/sync', {})).body;
    expect(filler.created).toEqual([]);
    expect(fake.lists.size).toBe(0);
    const made = (await call(fake.config, 'POST', '/local-videos/sync', {})).body.created[0];
    expect((fake.shows.get(made.id) as Array<{ id: string }>).map((entry) => entry.id)).toEqual([id(102), id(100), id(101)]);
  });

  it('adds a folder on the Tunarr server once, and follows or stops following it', async () => {
    const fake = tunarr({ LINEUP_DATA_DIR: await tempDir() });
    const added = await call(fake.config, 'POST', '/local-videos/add', { kind: 'videos', path: '/srv/downloads/Concerts', follow: false });
    expect(added).toMatchObject({ status: 201, body: { name: 'Videos – Concerts', existing: false } });
    expect((await call(fake.config, 'POST', '/local-videos/add', { kind: 'videos', path: '/srv/downloads/Concerts' })).body.existing).toBe(true);
    expect(fake.calls.filter((entry) => entry.method === 'POST' && entry.url === '/api/media-sources')).toHaveLength(1);
    expect((await call(fake.config, 'POST', '/local-videos/add', { kind: 'videos', path: 'relative' })).status).toBe(400);

    const { libraryId } = added.body;
    fake.files[libraryId] = ['Part 1'];
    fake.sources[0].libraries[0].lastScannedAt = SCANNED;
    const followed = await call(fake.config, 'PUT', `/local-videos/libraries/${libraryId}`, { follow: true });
    expect(followed.body).toMatchObject({ kind: 'videos', pending: false, show: { count: 1 } });
    expect((await call(fake.config, 'GET', '/local-videos')).body.folders).toEqual([expect.objectContaining({ key: `library:${libraryId}`, name: 'Concerts', show: expect.objectContaining({ id: followed.body.show.id }) })]);
    await call(fake.config, 'PUT', `/local-videos/libraries/${libraryId}`, { follow: false });
    expect((await call(fake.config, 'GET', '/local-videos')).body.folders[0].show).toBeNull();
    expect(fake.shows.size).toBe(1); // the show stays in Tunarr
    expect((await call(fake.config, 'PUT', `/local-videos/libraries/${id(9)}`, { follow: true })).status).toBe(404);
  });

  it('lists folders without Tunarr, and says why', async () => {
    const media = await tempDir();
    await mkdir(path.join(media, 'videos', 'Clips'), { recursive: true });
    const config = createProxyConfig({ LINEUP_MEDIA_DIR: media, LINEUP_DATA_DIR: await tempDir() });
    const listed = await call(config, 'GET', '/local-videos');
    expect(listed.body).toMatchObject({ tunarrError: expect.stringMatching(/Tunarr’s address/), folders: [expect.objectContaining({ name: 'Clips', tunarr: null })] });
    expect((await call(config, 'POST', '/local-videos/sync', {})).status).toBe(503);
  });
});

describe('local videos over HTTP', () => {
  const servers: http.Server[] = [];
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); });

  it('uploads, plays back and deletes videos in a folder', async () => {
    const media = await tempDir();
    await mkdir(path.join(media, 'music-videos', 'Hits'), { recursive: true });
    const server = createLineupServer({ config: createProxyConfig({ LINEUP_MEDIA_DIR: media, LINEUP_DATA_DIR: await tempDir() }), auth: null, staticRoot: await tempDir() });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const file = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tunarr/local-videos/files/music-videos/Hits/Abba%20-%20SOS.mp4`;
    const put = await fetch(file, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: 'video' });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({ kind: 'music-videos', folder: 'Hits', name: 'Abba - SOS.mp4', size: 5 });
    const played = await fetch(file, { headers: { range: 'bytes=1-2' } });
    expect(played.status).toBe(206);
    expect(await played.text()).toBe('id');
    expect((await fetch(file.replace('/Hits/', '/Missing/'), { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: 'x' })).status).toBe(404);
    expect((await fetch(file, { method: 'DELETE' })).status).toBe(200);
    expect(await readdir(path.join(media, 'music-videos', 'Hits'))).toEqual([]);
  });
});
