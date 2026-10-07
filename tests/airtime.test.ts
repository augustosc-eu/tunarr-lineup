import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { airKind, estimateBreakFill, hourSummaries, stripSegments, type ListSpots, type SpotIndex } from '../lib/airKinds';
import { makeBreakWithId, makeCommercialBreak, makeFlex, openBreaksWithIds, pickStationId } from '../lib/broadcast';
import { channelStationIds, guessRole, idChannel, nameTokens, roleOf, spotBreakdown, spotLength } from '../lib/fillerRoles';
import type { Instance, LineupItem } from '../lib/lineup';
import { createFillerRoleStore } from '../server/fillerRoleStore';
import { createProxyConfig, handleTunarrApi, type ProxyRequest } from '../server/tunarrProxy';

const MIN = 60_000;
const ADS = 'f0000000-0000-4000-8000-0000000000f1';
const IDS = 'f0000000-0000-4000-8000-0000000000f2';

describe('filler roles', () => {
  it('guesses a role from list names, preferring the specific word', () => {
    expect(guessRole('Station IDs')).toBe('station-id');
    expect(guessRole('Canal 9 identificadores')).toBe('station-id');
    expect(guessRole('Station Ads')).toBe('commercials');
    expect(guessRole('Tanda publicitaria')).toBe('commercials');
    expect(guessRole('Coming up promos')).toBe('promos');
    expect(guessRole('Bumpers')).toBe('bumpers');
    expect(guessRole('Saturday cartoons')).toBeUndefined();
    expect(roleOf({ id: ADS, name: 'Station Ads' }, { [ADS]: 'promos' })).toBe('promos');
  });

  it('writes spot lengths the broadcast way', () => {
    expect(spotLength(15_000)).toBe(':15');
    expect(spotLength(60_000)).toBe('1:00');
    expect(spotLength(150_400)).toBe('2:30');
    expect(spotBreakdown([30_000, 15_000, 30_000])).toEqual([{ length: ':15', count: 1 }, { length: ':30', count: 2 }]);
  });
});

describe('air kinds', () => {
  const spots: SpotIndex = new Map([['ident-1', 'station-id'], ['cola', 'commercials']]);

  it('tells programs, breaks, flex, spots and redirects apart', () => {
    expect(airKind({ type: 'content', id: 'movie', duration: MIN }, spots)).toBe('program');
    expect(airKind(makeFlex(MIN), spots)).toBe('flex');
    expect(airKind(makeCommercialBreak(MIN, [ADS]), spots)).toBe('break');
    expect(airKind({ type: 'content', id: 'ident-1', duration: 10_000 }, spots)).toBe('station-id');
    expect(airKind({ type: 'content', id: 'cola', duration: 30_000 }, spots)).toBe('commercial');
    expect(airKind({ type: 'filler', id: 'other', fillerListId: IDS, duration: 10_000 }, spots, { [IDS]: 'station-id' })).toBe('station-id');
    expect(airKind({ type: 'filler', id: 'other', duration: 10_000 }, spots)).toBe('filler');
    expect(airKind({ type: 'redirect', duration: MIN }, spots)).toBe('redirect');
  });

  const at = (hour: number, minute = 0) => new Date(2026, 9, 7, hour, minute).getTime();
  const row = (item: LineupItem, start: number): Instance => ({ item, lineupIndex: 0, start, stop: start + item.duration });
  const rows = [
    row({ type: 'content', id: 'movie', duration: 50 * MIN }, at(10)),
    row(makeCommercialBreak(10 * MIN, [ADS]), at(10, 50)),
    row(makeFlex(30 * MIN), at(11)),
    row(makeFlex(30 * MIN), at(11, 30)),
  ];
  const kindOf = (instance: Instance) => airKind(instance.item, spots);

  it('sums each clock hour by kind and splits rows across hours', () => {
    const hours = hourSummaries([row({ type: 'content', id: 'movie', duration: 80 * MIN }, at(9, 30)), ...rows.slice(1)], kindOf, at(0), at(24));
    expect(hours.get(at(9))?.byKind).toEqual({ program: 30 * MIN });
    expect(hours.get(at(10))?.byKind).toEqual({ program: 50 * MIN, break: 10 * MIN });
    expect(hours.get(at(11))?.byKind).toEqual({ flex: 60 * MIN });
  });

  it('merges neighbouring rows of the same kind into strip segments', () => {
    expect(stripSegments(rows, kindOf, at(0), at(24)).map((segment) => [segment.kind, (segment.stop - segment.start) / MIN, segment.position])).toEqual([['program', 50, 0], ['break', 10, 1], ['flex', 60, 2]]);
  });

  it('estimates a break: an ID first, then spots that fit, then flex', () => {
    const lists: Record<string, ListSpots> = {
      [IDS]: { name: 'Idents', role: 'station-id', spots: [{ id: 'ident-1', title: 'Ident', duration: 10_000 }] },
      [ADS]: { name: 'Ads', role: 'commercials', spots: [{ id: 'cola', title: 'Cola', duration: 30_000 }] },
    };
    const lines = estimateBreakFill(makeCommercialBreak(MIN + 50_000, [ADS, IDS]), MIN + 50_000, lists, 7);
    expect(lines.map((line) => [line.kind, line.duration / 1000])).toEqual([['station-id', 10], ['commercial', 30], ['commercial', 30], ['commercial', 30], ['flex', 10]]);
    expect(estimateBreakFill(makeCommercialBreak(MIN, [ADS, IDS]), MIN, lists, 7, true)[0].kind).toBe('commercial');
    expect(estimateBreakFill(makeCommercialBreak(MIN, ['missing']), MIN, lists, 7)).toEqual([expect.objectContaining({ kind: 'flex', duration: MIN })]);
  });
});

describe('station IDs in breaks', () => {
  const ids = [{ id: 'ident-a', duration: 10_000 }, { id: 'ident-b', duration: 10_000 }];
  const content = (id: string, minutes = 30): LineupItem => ({ type: 'content', id, duration: minutes * MIN });

  it('rotates to the least-used ID', () => {
    expect(pickStationId(ids, [])?.id).toBe('ident-a');
    expect(pickStationId(ids, [content('ident-a')])?.id).toBe('ident-b');
    expect(pickStationId([], [])).toBeUndefined();
  });

  it('builds a break that opens with an ID and keeps its length', () => {
    const items = makeBreakWithId(2 * MIN, [ADS], ids[0], 5 * MIN);
    expect(items).toEqual([{ type: 'content', id: 'ident-a', duration: 10_000 }, makeCommercialBreak(2 * MIN - 10_000, [ADS], 5 * MIN)]);
    expect(makeBreakWithId(10_500, [ADS], ids[0])).toHaveLength(1);
  });

  it('opens each break that lacks one, rotating IDs and keeping other fields', () => {
    const breakItem = { ...makeCommercialBreak(3 * MIN, [ADS]), persisted: true };
    const lineup = [content('show'), breakItem, content('show-2'), { ...breakItem }, content('ident-b'), { ...breakItem }];
    const result = openBreaksWithIds(lineup, ids, (item) => item.id?.startsWith('ident-') ?? false)!;
    expect(result.added).toBe(2);
    expect(result.lineup.map((item) => item.id ?? item.type)).toEqual(['show', 'ident-a', 'flex', 'show-2', 'ident-a', 'flex', 'ident-b', 'flex']);
    expect(result.lineup[2]).toEqual({ ...breakItem, duration: 3 * MIN - 10_000 });
    expect(openBreaksWithIds([content('show')], ids, () => false)).toBeNull();
  });
});

describe('filler role store and routes', () => {
  const req = (method: string, url: string, body?: unknown): ProxyRequest => ({
    method, url: `/api/tunarr${url}`, headers: { host: 'lineup.local', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parse = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

  it('keeps roles in filler-roles.json and never overwrites a broken file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lineup-roles-'));
    const store = createFillerRoleStore(dir);
    expect(await store.list()).toEqual({});
    await Promise.all([store.set(ADS, 'commercials'), store.set(IDS, 'station-id')]);
    expect(await store.list()).toEqual({ [ADS]: 'commercials', [IDS]: 'station-id' });
    expect(await store.remove(ADS)).toEqual({ [IDS]: 'station-id' });
    expect(JSON.parse(await readFile(path.join(dir, 'filler-roles.json'), 'utf8'))).toEqual({ version: 1, roles: { [IDS]: 'station-id' } });
    await writeFile(path.join(dir, 'filler-roles.json'), '{ nope');
    await expect(store.set(ADS, 'promos')).rejects.toMatchObject({ code: 'store_corrupt' });
    expect(await readFile(path.join(dir, 'filler-roles.json'), 'utf8')).toBe('{ nope');
  });

  it('answers without Tunarr and validates ids and roles', async () => {
    const config = { ...createProxyConfig({}), fillerRoles: createFillerRoleStore(await mkdtemp(path.join(tmpdir(), 'lineup-roles-'))) };
    expect(parse(await handleTunarrApi(req('GET', '/filler-roles'), config))).toEqual({});
    expect(parse(await handleTunarrApi(req('PUT', `/filler-roles/${IDS}`, { role: 'station-id' }), config))).toEqual({ [IDS]: 'station-id' });
    expect((await handleTunarrApi(req('PUT', `/filler-roles/${IDS}`, { role: 'admin' }), config)).status).toBe(400);
    expect((await handleTunarrApi(req('PUT', '/filler-roles/../../etc', { role: 'promos' }), config)).status).not.toBe(200);
    expect((await handleTunarrApi(req('PUT', '/filler-roles/not-a-uuid', { role: 'promos' }), config)).status).toBe(400);
    expect((await handleTunarrApi(req('POST', '/filler-roles', {}), config)).status).toBe(405);
    expect((await handleTunarrApi({ ...req('PUT', `/filler-roles/${IDS}`, { role: 'promos' }), headers: { host: 'lineup.local', origin: 'https://evil.example', 'content-type': 'application/json' } }, config)).status).toBe(403);
    expect(parse(await handleTunarrApi(req('DELETE', `/filler-roles/${IDS}`), config))).toEqual({});
  });
});

describe('station IDs by channel', () => {
  const channels = [
    { id: 'el7', name: 'El 7' }, { id: 'el109', name: 'El 109' }, { id: 'jdrama', name: 'JDrama TV' }, { id: 'drama', name: 'Drama TV' },
    { id: 'canal12', name: 'Canal 12' }, { id: 'canal23', name: 'Canal 23' }, { id: 'comedy', name: 'Comedy' }, { id: 'comedy-movies', name: 'Comedy Movies' },
  ];
  const owner = (title: string) => idChannel(title, channels)?.id;

  it('finds the channel an ID file is named for, word for word', () => {
    expect(nameTokens('EL109 ID B.mp4')).toEqual(['el', '109', 'id', 'b', 'mp', '4']);
    expect(owner('EL 7 ID')).toBe('el7');
    expect(owner('EL109 ID B')).toBe('el109');
    expect(owner('EL109 ID')).toBe('el109');
    expect(owner('JDRAMA TV ID V2')).toBe('jdrama');
    expect(owner('Canal 12 v1')).toBe('canal12');
    expect(owner('Comedy Movies ident')).toBe('comedy-movies');
    expect(owner('Comedia ident')).toBeUndefined();
    expect(owner('Ident Sunrise')).toBeUndefined();
  });

  const id = (key: string, title: string) => ({ id: key, title });
  const byList = {
    folder: [id('a', 'EL 7 ID'), id('b', 'EL109 ID'), id('c', 'Generic ident')],
    music: [id('d', 'Music ident'), id('a', 'EL 7 ID')],
  };
  const pool = (channel: string, assigned: string[] = []) => channelStationIds(byList, assigned, channels.find((item) => item.id === channel), channels, (item) => item.title);

  it('gives a channel the IDs named for it, never another channel’s', () => {
    expect(pool('el7')).toEqual({ ids: [byList.folder[0]], own: true });
    expect(pool('el109')).toEqual({ ids: [byList.folder[1]], own: true });
  });

  it('adds a ticked list’s IDs, minus those named for other channels', () => {
    expect(pool('el7', ['music']).ids.map((item) => item.id)).toEqual(['a', 'd']);
    expect(pool('el109', ['folder']).ids.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('falls back to the IDs named for no channel', () => {
    expect(pool('canal12')).toEqual({ ids: [byList.folder[2], byList.music[0]], own: false });
  });
});
