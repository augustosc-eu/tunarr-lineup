import { describe, expect, it, vi } from 'vitest';
import { readExport } from '../app/components/SnapshotsDialog';
import { airKind } from '../lib/airKinds';
import { alignToClock, clockRemainder, makeCommercialBreak, makeFlex } from '../lib/broadcast';
import { companionDrafts, createDraftStore, sharedDraftStore, type StoredDraft } from '../lib/draftStore';
import { airOncePatches, buildMarathon, placeEvent } from '../lib/events';
import { byNetwork, cellsFor, stepFocus, windowStart } from '../lib/guideGrid';
import { checkLineup, DEFAULT_CHECK_SETTINGS, redirectLoop } from '../lib/lineupCheck';
import { dayRange, instancesForDay, type LineupItem } from '../lib/lineup';
import { dateRange, dayBlocks, logRows, projectDays, weekStart, weekSummary } from '../lib/weekLog';
import { itemIdentity } from '../server/lineupVersion';

const MIN = 60_000;
const day = '2026-10-19';
const midnight = dayRange(day).from.getTime();
const ep = (id: string, minutes: number): LineupItem => ({ type: 'content', id, duration: minutes * MIN });
const programs = {
  a: { program: { type: 'episode', title: 'Pilot', show: { title: 'Bravo' }, seasonNumber: 1, episodeNumber: 1 } },
  b: { program: { type: 'episode', title: 'Second', show: { title: 'Bravo' }, seasonNumber: 1, episodeNumber: 2 } },
  c: { program: { type: 'movie', title: 'Cobra', year: 1986, rating: 'R' } },
};
const kindOf = (row: { item: LineupItem }) => airKind(row.item, new Map());
const check = (lineup: LineupItem[], extra: Partial<Parameters<typeof checkLineup>[0]> = {}) => checkLineup({
  lineup, programs, rows: instancesForDay(lineup, midnight, day), kindOf, channelId: 'one', channels: [{ id: 'one', number: 1, name: 'One' }, { id: 'two', number: 2, name: 'Two' }],
  channelFillerListIds: [], knownFillerListIds: new Set(['ads']), settings: DEFAULT_CHECK_SETTINGS, ...extra,
});

describe('lineup check', () => {
  it('finds programs Tunarr no longer has, zero-length items and redirects to missing or the same channel', () => {
    const issues = check([ep('a', 30), ep('gone', 30), { type: 'flex', duration: 0 }, { type: 'redirect', channel: 'one', duration: 10 * MIN }, { type: 'redirect', channel: 'nope', channelName: 'Old', duration: 10 * MIN }]);
    const ids = issues.map((issue) => issue.id.replace(/-\d+$/, ''));
    expect(ids).toEqual(expect.arrayContaining(['missing-program', 'zero-length', 'redirect-self', 'redirect-missing']));
    expect(issues[0].severity).toBe('error');
  });

  it('flags the same episode twice in a day, and twice in a row with only a break between', () => {
    // A 90-minute cycle repeats 16 times a day: every episode repeats.
    const issues = check([ep('a', 30), makeCommercialBreak(2 * MIN, ['ads']), ep('a', 30), ep('b', 28)]);
    expect(issues.some((issue) => issue.id.startsWith('twice-'))).toBe(true);
    expect(issues.find((issue) => issue.id.startsWith('repeat-a-'))?.title).toContain('“Bravo · S01 E01 · Pilot” airs');
  });

  it('warns about flex time with no filler, breaks from deleted lists, and hours over the commercial limit', () => {
    const issues = check([ep('a', 30), makeFlex(30 * MIN), makeCommercialBreak(25 * MIN, ['deleted']), ep('b', 35)]);
    expect(issues.map((issue) => issue.id)).toEqual(expect.arrayContaining(['flex-offline', 'break-missing-list']));
    expect(issues.some((issue) => issue.id.startsWith('ads-'))).toBe(true);
    expect(issues.some((issue) => issue.id.startsWith('long-flex-'))).toBe(true);
    // Off, the hour check says nothing.
    expect(check([ep('a', 30), makeCommercialBreak(25 * MIN, ['ads'])], { settings: { ...DEFAULT_CHECK_SETTINGS, maxCommercialMinutes: null } }).some((issue) => issue.id.startsWith('ads-'))).toBe(false);
  });

  it('flags mature ratings in family hours only when asked', () => {
    const lineup = [ep('c', 120)];
    expect(check(lineup).some((issue) => issue.id.startsWith('mature-'))).toBe(false);
    const flagged = check(lineup, { settings: { ...DEFAULT_CHECK_SETTINGS, familyHours: { from: 6, to: 21 } } }).filter((issue) => issue.id.startsWith('mature-'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].title).toContain('(R)');
  });

  it('finds redirect loops through this channel', () => {
    expect(redirectLoop('one', [{ from: 'one', to: 'two' }, { from: 'two', to: 'three' }, { from: 'three', to: 'one' }])).toEqual(['one', 'two', 'three', 'one']);
    expect(redirectLoop('one', [{ from: 'one', to: 'two' }, { from: 'two', to: 'three' }])).toBeNull();
    const issues = check([ep('a', 30), { type: 'redirect', channel: 'two', duration: 10 * MIN }], { redirectEdges: [{ from: 'two', to: 'one' }] });
    expect(issues.find((issue) => issue.id === 'redirect-loop')?.detail).toBe('CH 1 One → CH 2 Two → CH 1 One. A viewer sent round this loop never reaches a program.');
  });
});

describe('aligning to the clock', () => {
  const start = midnight + 7 * MIN;
  const isProgram = (item: LineupItem) => item.type === 'content';

  it('pads before each program so it starts on the grid, and pads the end to a whole number of steps', () => {
    const result = alignToClock([ep('a', 22), ep('b', 44)], start, 30 * MIN, isProgram, makeFlex)!;
    expect(result.lineup.map((item) => [item.type, item.duration / MIN])).toEqual([['flex', 23], ['content', 22], ['flex', 8], ['content', 44], ['flex', 23]]);
    // Every program starts on :00 or :30, and the cycle is a multiple of 30 minutes.
    let cursor = start;
    for (const item of result.lineup) {
      if (item.type === 'content') expect(clockRemainder(cursor, 30 * MIN)).toBe(0);
      cursor += item.duration;
    }
    expect((cursor - start) % (30 * MIN)).toBe(0);
  });

  it('lengthens a break already before a program instead of adding another, and leaves aligned lineups alone', () => {
    const result = alignToClock([ep('a', 25), makeCommercialBreak(2 * MIN, ['ads']), ep('b', 30)], midnight, 30 * MIN, isProgram, makeFlex)!;
    expect(result.pads).toBe(0);
    expect(result.added).toBe(3 * MIN);
    expect(result.lineup[1]).toMatchObject({ type: 'flex', duration: 5 * MIN, fillerConfig: { fillerListIds: ['ads'] } });
    expect(alignToClock([ep('a', 30), ep('b', 30)], midnight, 30 * MIN, isProgram, makeFlex)).toBeNull();
  });
});

describe('marathons and events that air once', () => {
  it('puts a break between episodes but not after the last', () => {
    const items = buildMarathon([ep('a', 30), ep('b', 30)], { breakMs: 3 * MIN, fillerListIds: ['ads'], stationId: { id: 'id1', duration: 10_000 } });
    expect(items.map((item) => item.type)).toEqual(['content', 'content', 'flex', 'content']);
    expect(items[1]).toMatchObject({ id: 'id1' });
    expect(items[2].duration).toBe(3 * MIN - 10_000);
    expect(buildMarathon([ep('a', 30), ep('b', 30)], { breakMs: 0, fillerListIds: [] })).toHaveLength(2);
  });

  it('makes the patch that puts an event in and the one that takes it out', () => {
    const lineup = [ep('a', 30), ep('b', 30), ep('c', 60)];
    const placement = placeEvent(lineup, midnight, midnight + 30 * MIN, [ep('e', 50)], 'replace')!;
    const patches = airOncePatches(placement)!;
    expect(patches.apply).toEqual({ index: 1, remove: [itemIdentity(lineup[1]), itemIdentity(lineup[2])], insert: [ep('e', 50), makeFlex(40 * MIN)] });
    expect(patches.undo.insert).toEqual([lineup[1], lineup[2]]);
    expect(patches.undo.remove).toEqual(patches.apply.insert.map(itemIdentity));
    expect(airOncePatches(placeEvent(lineup, midnight, midnight + 60 * MIN, [ep('e', 200)], 'replace')!)).toBeNull();
  });
});

describe('week log', () => {
  it('lists dates, finds the Monday, and folds episodes and breaks into blocks', () => {
    expect(dateRange('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(weekStart('2026-10-22')).toBe('2026-10-19');
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    const lineup = [ep('a', 30), makeCommercialBreak(2 * MIN, ['ads']), ep('b', 28), ep('c', 120)];
    const [today] = projectDays(lineup, midnight, [day]);
    const blocks = dayBlocks(today.rows, programs, kindOf, midnight, midnight + 24 * 60 * MIN);
    expect(blocks[0]).toMatchObject({ title: 'Bravo', count: 2, start: midnight, stop: midnight + 60 * MIN });
    expect(blocks[1]).toMatchObject({ title: 'Cobra', detail: '1986 · movie' });
  });

  it('exports several days and summarizes a week for the AI review', () => {
    const days = projectDays([ep('a', 720), ep('c', 720)], midnight, dateRange(day, 2));
    const rows = logRows(days, programs, kindOf, (kind) => kind);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual([day, '00:00:00', '12:00:00', '12:00:00', 'program', 'Bravo', 'S01 E01 · Pilot', 1]);
    const summary = weekSummary(days, programs, kindOf);
    expect(summary).toContain('00:00–12:00 Bravo · S01 E01 · Pilot');
    expect(weekSummary(days, programs, kindOf, 40)).toContain('(… cut short)');
  });
});

describe('guide grid', () => {
  const programsOn = [{ start: midnight, stop: midnight + 30 * MIN, type: 'content', title: 'A', detail: '' }, { start: midnight + 30 * MIN, stop: midnight + 90 * MIN, type: 'content', title: 'B', detail: '' }];

  it('opens on the half hour and lays programs out in the window', () => {
    expect(windowStart(midnight + 47 * MIN)).toBe(midnight + 30 * MIN);
    const cells = cellsFor(programsOn, midnight + 60 * MIN, midnight + 240 * MIN);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ left: 0, clippedStart: true, clippedEnd: false });
    expect(cells[0].width).toBeCloseTo((30 / 180) * 100);
  });

  it('steps between programs and groups channels by network', () => {
    expect(stepFocus(programsOn, midnight + 10 * MIN, 1)).toBe(midnight + 30 * MIN);
    expect(stepFocus(programsOn, midnight + 40 * MIN, -1)).toBe(midnight);
    expect(stepFocus(programsOn, midnight + 40 * MIN, 1)).toBeNull();
    const groups = byNetwork([{ number: 3, groupTitle: 'Kids' }, { number: 1, groupTitle: 'News' }, { number: 2, groupTitle: 'Kids' }, { number: 4 }]);
    expect(groups.map((group) => [group.network, group.channels.map((channel) => channel.number)])).toEqual([['News', [1]], ['Kids', [2, 3]], ['Other channels', [4]]]);
  });
});

describe('shared drafts in the browser', () => {
  const draft = (updatedAt: number, dirty = true): StoredDraft => ({ channelId: 'chan', version: 'v-1-2', updatedAt, dirty, current: [0], past: [], future: [] });

  it('uses the newer copy and writes to both when the companion keeps drafts', async () => {
    const remote = { list: vi.fn(async () => [{ channelId: 'chan', version: 'v-1-2', updatedAt: 20, dirty: true }]), get: vi.fn(async () => draft(20)), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const store = sharedDraftStore(createDraftStore(undefined), remote);
    await store.put(draft(10));
    expect(remote.put).toHaveBeenCalled();
    expect((await store.get('chan'))?.updatedAt).toBe(20);
    expect(store.shared).toBe(true);
    expect((await store.list()).map((item) => item.updatedAt)).toEqual([20]);
    await store.delete('chan');
    expect(remote.delete).toHaveBeenCalledWith('chan');
  });

  it('works alone when the companion has no draft routes', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>not found</html>', { status: 404 }));
    const store = sharedDraftStore(createDraftStore(undefined), companionDrafts(fetchMock as unknown as typeof fetch));
    await store.put(draft(5));
    expect((await store.get('chan'))?.updatedAt).toBe(5);
    expect(store.shared).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('lineup files', () => {
  it('reads an exported lineup and refuses anything else', () => {
    const good = JSON.stringify({ kind: 'tunarr-lineup-export', version: 1, lineup: [ep('a', 30)], programs: { a: programs.a } });
    expect(readExport(good)).toMatchObject({ lineup: [ep('a', 30)] });
    expect(readExport('{nope')).toHaveProperty('error');
    expect(readExport(JSON.stringify({ lineup: [] }))).toHaveProperty('error');
    expect(readExport(JSON.stringify({ kind: 'tunarr-lineup-export', lineup: [{ type: 'rm', duration: 1 }] }))).toHaveProperty('error');
  });
});
