import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeEvent, repeatLabel } from '../lib/events';
import type { LineupItem } from '../lib/lineup';
import { DAY_MS, type ScheduleDraftState, type SourceOption } from '../lib/schedule';
import { BUILT_IN_TEMPLATES, inGroup } from '../lib/templateCatalog';
import { daySegments, defaultSource, isWeekly, midRollFor, roleUsage, scheduleToTemplate, templateToDraft, weekGrid, AD_STYLES, type Template } from '../lib/templates';
import { buildSchedule } from '../server/slotSchedule';
import { validateTemplate } from '../server/templateSchema';
import { createTemplateStore } from '../server/templateStore';

const HOUR = 3_600_000;
const MIN = 60_000;
const ADS = 'f0000000-0000-4000-8000-0000000000f1';
const PROMOS = 'f0000000-0000-4000-8000-0000000000f2';
const collection = (n: number): SourceOption => {
  const id = `5a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { key: `smart-collection:${id}`, label: `Collection ${n}`, template: { type: 'smart-collection', smartCollectionId: id, order: 'shuffle', direction: 'asc' } };
};
const fillAll = (roles: Array<{ id: string }>) => Object.fromEntries(roles.map((role, index) => [role.id, collection(index + 1)]));
const byId = (id: string) => BUILT_IN_TEMPLATES.find((template) => template.id === id)!;
const startsOf = (draft: ScheduleDraftState, n: number) => draft.slots.filter((slot) => slot.smartCollectionId === collection(n).template.smartCollectionId).map((slot) => Number(slot.startTime));

describe('built-in templates', () => {
  it('covers the mainstream channels of every country', () => {
    const regions = (region: string) => BUILT_IN_TEMPLATES.filter((template) => inGroup(template, region as never)).map((template) => template.id);
    expect(regions('Japan')).toEqual(['jp-nhk-g', 'jp-nhk-e', 'jp-ntv', 'jp-tbs', 'jp-fuji', 'jp-tv-asahi', 'jp-tv-tokyo']);
    expect(regions('Argentina')).toEqual(['ar-telefe', 'ar-eltrece', 'ar-tvpublica', 'ar-america', 'ar-elnueve', 'ar-tn']);
    expect(regions('Spain')).toEqual(['es-la1', 'es-la2', 'es-antena3', 'es-telecinco', 'es-cuatro', 'es-lasexta']);
    expect(regions('United Kingdom')).toEqual(['uk-bbc-one', 'uk-bbc-two', 'uk-itv1', 'uk-channel4', 'uk-channel5']);
    expect(regions('Italy')).toEqual(['it-rai1', 'it-rai2', 'it-rai3', 'it-canale5', 'it-italia1', 'it-rete4', 'it-la7']);
    expect(regions('United States')).toEqual(expect.arrayContaining(['us-abc', 'us-cbs', 'us-nbc', 'us-fox', 'us-cw', 'us-pbs', 'us-univision', 'us-telemundo', 'us-espn', 'us-cnn', 'us-hbo', 'us-nickelodeon', 'us-disney', 'us-cartoon-network', 'us-discovery', 'us-mtv', 'us-tcm']));
    expect(regions('General')).toEqual(['general', 'kids', 'movies', 'music', 'news']);
  });

  it('every built-in passes the template schema and uses every role it defines', () => {
    const ids = new Set<string>();
    for (const template of BUILT_IN_TEMPLATES) {
      expect(ids.has(template.id), template.id).toBe(false);
      ids.add(template.id);
      const checked = validateTemplate(template);
      if ('error' in checked) throw new Error(`${template.id}: ${checked.error}`);
      expect([...roleUsage(template).keys()].sort(), template.id).toEqual(template.roles.map((role) => role.id).sort());
      if (template.region !== 'Anywhere') expect(template.inspiredBy, template.id).toMatch(/^Inspired by /);
    }
  });

  it('turns every built-in into a schedule the companion accepts', () => {
    for (const template of BUILT_IN_TEMPLATES) {
      const draft = templateToDraft(template, fillAll(template.roles), { commercials: ADS, promos: PROMOS });
      const built = buildSchedule(null, { type: draft.type, settings: draft.settings, slots: draft.slots });
      if ('error' in built) throw new Error(`${template.id}: ${built.error}`);
      expect(built.schedule.period).toBe(isWeekly(template) ? 'week' : 'day');
    }
  });

  it('places weekday overrides on their own day (Sunday is day 0)', () => {
    // Fuji TV's Monday 21:00 drama.
    const fuji = byId('jp-fuji');
    const drama = fuji.roles.findIndex((role) => role.id === 'drama') + 1;
    const fujiDraft = templateToDraft(fuji, fillAll(fuji.roles), {});
    expect(startsOf(fujiDraft, drama).filter((start) => start % DAY_MS === 21 * HOUR).map((start) => Math.floor(start / DAY_MS))).toEqual([1, 6, 0].sort());
    // ESPN's Monday-night football at 20:15.
    const espn = byId('us-espn');
    const sports = espn.roles.findIndex((role) => role.id === 'sports') + 1;
    expect(startsOf(templateToDraft(espn, fillAll(espn.roles), {}), sports)).toContain(1 * DAY_MS + 20 * HOUR + 15 * MIN);
    // NHK's Sunday 20:00 historical drama airs only on Sunday.
    const nhk = byId('jp-nhk-g');
    const taiga = nhk.roles.findIndex((role) => role.id === 'history') + 1;
    expect(startsOf(templateToDraft(nhk, fillAll(nhk.roles), {}), taiga)).toEqual([20 * HOUR]);
    expect(weekGrid(byId('us-nbc'))[6].some(([at, role]) => at === '23:30' && role === 'variety')).toBe(true);
  });
});

describe('ad levels', () => {
  it('scales mid-roll breaks by level', () => {
    expect(midRollFor(AD_STYLES.us, 'standard')).toMatchObject({ breakRule: { intervalMs: 8 * MIN }, breakDurationMs: 3 * MIN, maxBreaks: 6 });
    expect(midRollFor(AD_STYLES.us, 'light')).toMatchObject({ breakRule: { intervalMs: 13 * MIN }, maxBreaks: 4 });
    expect(midRollFor(AD_STYLES.us, 'heavy')).toMatchObject({ breakRule: { intervalMs: 6 * MIN }, breakDurationMs: 4 * MIN, maxBreaks: 7 });
    expect(midRollFor(AD_STYLES.us, 'none')).toBeUndefined();
    expect(midRollFor(AD_STYLES.premium, 'heavy')).toBeUndefined();
  });

  it('applies each block’s level, keeping promos on ad-free blocks', () => {
    const template: Template = {
      id: 'levels', name: 'Levels', inspiredBy: '', region: 'Anywhere', description: '', ads: AD_STYLES.us, padMs: 1, latenessMs: 0,
      roles: [{ id: 'a', label: 'A', hint: '', order: 'shuffle' }],
      days: { all: [['06:00', 'a', 'none'], ['12:00', 'a'], ['20:00', 'a', 'heavy']] },
    };
    const draft = templateToDraft(template, { a: collection(1) }, { commercials: ADS, promos: PROMOS });
    expect(draft.slots[0]).toMatchObject({ filler: [{ fillerListId: PROMOS }] });
    expect(draft.slots[0].midRoll).toBeUndefined();
    expect(draft.slots[1]).toMatchObject({ filler: [{ fillerListId: ADS, types: ['mid', 'post'] }, { fillerListId: PROMOS }], midRoll: { breakRule: { intervalMs: 8 * MIN } } });
    expect(draft.slots[2]).toMatchObject({ midRoll: { breakRule: { intervalMs: 6 * MIN } } });
    const bare = templateToDraft(template, { a: collection(1) }, {});
    expect(bare.slots.every((slot) => slot.filler === undefined && slot.midRoll === undefined)).toBe(true);
  });

  it('leaves out blocks whose role has no source', () => {
    const general = byId('general');
    const draft = templateToDraft(general, { drama: collection(1) }, {});
    expect(draft.settings.period).toBe('day');
    expect(draft.slots.map((slot) => slot.startTime)).toEqual([2, 14, 20].map((hour) => hour * HOUR));
    expect(draft.slots.every((slot) => slot.order === 'next')).toBe(true);
    expect(daySegments([['06:00', 'a'], ['22:00', 'b']])).toEqual([{ start: 6 * HOUR, end: 22 * HOUR, roleId: 'a', level: 'standard' }, { start: 22 * HOUR, end: DAY_MS + 6 * HOUR, roleId: 'b', level: 'standard' }]);
  });
});

describe('saving a channel’s format as a template', () => {
  const SHOW = '7a7a7a7a-1a2b-4c3d-8e9f-0000000000f1';
  const show = (start: number, extra = {}) => ({ id: crypto.randomUUID(), type: 'show', showId: SHOW, show: { title: 'Rotation Show' }, order: 'next', direction: 'asc', startTime: start, ...extra });
  const movie = (start: number) => ({ id: crypto.randomUUID(), type: 'movie', order: 'shuffle', direction: 'asc', startTime: start });

  it('turns time slots into roles with defaults and rebuilds the same schedule', () => {
    const midRoll = { breakRule: { type: 'fixed_interval', intervalMs: 9 * MIN }, breakDurationMs: 2 * MIN, maxBreaks: 3, minProgramDurationMs: 20 * MIN };
    const slots = [
      ...[1, 2, 3, 4, 5].map((day) => show(day * DAY_MS + 18 * HOUR, { midRoll, filler: [{ types: ['mid'], fillerListId: ADS }] })),
      ...[1, 2, 3, 4, 5].map((day) => movie(day * DAY_MS + 21 * HOUR)),
      movie(6 * DAY_MS + 20 * HOUR), movie(20 * HOUR),
      { type: 'flex', startTime: 6 * DAY_MS + 23 * HOUR },
    ];
    const draft: ScheduleDraftState = { type: 'time', settings: { period: 'week', padMs: 5 * MIN, latenessMs: 15 * MIN }, slots, extraMovies: [] };
    const saved = scheduleToTemplate(draft, 'Rotation format');
    expect(saved).not.toBeNull();
    expect(saved!.roles.map((role) => role.label)).toEqual(['Movies', 'Rotation Show']);
    expect(saved!.days).toEqual({ weekdays: [['18:00', 'r2'], ['21:00', 'r1', 'none']], saturday: [['20:00', 'r1', 'none']], sunday: [['20:00', 'r1', 'none']] });
    expect(saved!.ads.midRoll).toEqual({ everyMin: 9, breakMin: 2, maxBreaks: 3, minProgramMin: 20 });
    expect(saved!.defaults!.r2).toMatchObject({ key: `show:${SHOW}`, template: { type: 'show', showId: SHOW } });
    const checked = validateTemplate({ ...saved, id: 'my-rotation' });
    if ('error' in checked) throw new Error(checked.error);
    const sources = Object.fromEntries(Object.entries(checked.template.defaults!).map(([role, value]) => [role, defaultSource(value)]));
    const rebuilt = templateToDraft(checked.template, sources, {});
    expect(rebuilt.slots.map((slot) => [slot.type, slot.startTime])).toEqual(slots.filter((slot) => slot.type !== 'flex').map((slot) => [slot.type, slot.startTime]).sort((a, b) => Number(a[1]) - Number(b[1])));
    expect(scheduleToTemplate({ ...draft, type: 'random' }, 'x')).toBeNull();
  });
});

describe('template schema', () => {
  const base = { id: 'my-x', name: 'X', roles: [{ id: 'a', label: 'A', order: 'shuffle' }], days: { all: [['06:00', 'a']] }, ads: { commercialsAt: [], promosAt: [] } };
  it('rejects malformed plans', () => {
    expect(validateTemplate(base)).toHaveProperty('template');
    expect(validateTemplate({ ...base, days: { all: [['25:00', 'a']] } })).toHaveProperty('error');
    expect(validateTemplate({ ...base, days: { all: [['06:00', 'zz']] } })).toEqual({ error: 'Every day: block at 06:00 uses an unknown role.' });
    expect(validateTemplate({ ...base, days: { all: [['06:00', 'a'], ['06:00', 'a']] } })).toHaveProperty('error');
    expect(validateTemplate({ ...base, days: { weekdays: [['06:00', 'a']], saturday: [] } })).toEqual({ error: 'The day plan needs sunday.' });
    expect(validateTemplate({ ...base, roles: [{ id: 'a', label: 'A', order: 'shuffle', suggest: { match: 'all', rules: [{ field: 'password', op: 'is', values: ['x'] }] } }] })).toHaveProperty('error');
    expect(validateTemplate({ ...base, id: '../etc' })).toHaveProperty('error');
  });
  it('keeps only plain source fields in role defaults', () => {
    const checked = validateTemplate({ ...base, defaults: { a: { key: 'show:x', label: 'X', template: { type: 'show', showId: 'x', show: { title: 'X', secret: 'y', libraryId: 'l' }, startTime: 5, evil: true } }, b: { key: 'k', label: 'K', template: { type: 'show' } } } });
    if ('error' in checked) throw new Error(checked.error);
    expect(checked.template.defaults).toEqual({ a: { key: 'show:x', label: 'X', template: { type: 'show', showId: 'x', show: { title: 'X', libraryId: 'l' } } } });
  });
});

describe('saved template store', () => {
  const template = (id: string, name = 'Mine') => (validateTemplate({ id, name, roles: [{ id: 'a', label: 'A', order: 'shuffle' }], days: { all: [['06:00', 'a']] }, ads: { commercialsAt: [], promosAt: [] } }) as { template: Template }).template;

  it('saves, lists, replaces and removes templates in one JSON file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lineup-store-'));
    const store = createTemplateStore(dir);
    expect(await store.list()).toEqual([]);
    await Promise.all([store.save(template('my-a', 'A')), store.save(template('my-b', 'B'))]);
    expect((await store.list()).map((item) => [item.id, item.custom])).toEqual([['my-a', true], ['my-b', true]]);
    await store.save(template('my-a', 'A2'));
    expect((await store.list()).map((item) => item.name)).toEqual(['A2', 'B']);
    expect(await store.remove('my-a')).toBe(true);
    expect(await store.remove('my-a')).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, 'templates.json'), 'utf8'))).toMatchObject({ version: 1, templates: [{ id: 'my-b' }] });
  });

  it('never overwrites a file it can’t read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lineup-store-'));
    await writeFile(path.join(dir, 'templates.json'), '{ not json');
    const store = createTemplateStore(dir);
    await expect(store.save(template('my-a'))).rejects.toMatchObject({ code: 'store_corrupt' });
    expect(await readFile(path.join(dir, 'templates.json'), 'utf8')).toBe('{ not json');
  });
});

describe('events on a date', () => {
  const start = Date.UTC(2026, 9, 1, 0, 0);
  const item = (id: string, minutes: number): LineupItem => ({ type: 'content', id, duration: minutes * MIN });
  const lineup = [item('a', 60), item('b', 30), item('c', 90), item('d', 60)]; // 4-hour cycle
  const event = [item('match', 100)];

  it('replaces what was on and keeps later programs on time', () => {
    // 2 days + 01:10 is inside "b" (01:00–01:30), so the event starts at 01:30.
    const at = start + 2 * DAY_MS + 70 * MIN;
    const placed = placeEvent(lineup, start, at, event, 'replace')!;
    expect(placed.start).toBe(start + 2 * DAY_MS + 90 * MIN);
    expect(placed.drift).toBe(20 * MIN);
    expect(placed.removed.map((entry) => entry.id)).toEqual(['c', 'd']);
    expect(placed.pad).toBe(50 * MIN);
    expect(placed.lineup.map((entry) => entry.id ?? entry.type)).toEqual(['a', 'b', 'match', 'flex']);
    expect(placed.cycle).toBe(4 * HOUR);
    expect(repeatLabel(placed.cycle)).toBe('every 4 hours');
  });

  it('can start early in place of the program on air, or push everything later', () => {
    const at = start + 70 * MIN;
    const early = placeEvent(lineup, start, at, event, 'replace', 'before')!;
    expect(early.start).toBe(start + 60 * MIN);
    expect(early.removed.map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(early.pad).toBe(20 * MIN);
    const pushed = placeEvent(lineup, start, at, event, 'push')!;
    expect(pushed.lineup.map((entry) => entry.id)).toEqual(['a', 'b', 'match', 'c', 'd']);
    expect(pushed.cycle).toBe(4 * HOUR + 100 * MIN);
    expect(placeEvent([], start, at, event, 'replace')).toBeNull();
    expect(placeEvent(lineup, start, start + 60 * MIN, event, 'replace')!.drift).toBe(0);
  });
});
