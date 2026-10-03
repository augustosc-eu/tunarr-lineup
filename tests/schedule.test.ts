import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createDraftStore, decodeDraft, encodeDraft } from '../lib/draftStore';
import { rebaseHistory, record, type History } from '../lib/history';
import type { LineupItem } from '../lib/lineup';
import {
  changeSlotSource,
  clockToOffset,
  DAY_MS,
  duplicateSlot,
  offsetToClock,
  shiftTimeSlots,
  slotProblems,
  slotWeightShare,
  sourceOptions,
  type Slot,
} from '../lib/schedule';
import { programmingVersion } from '../server/lineupVersion';
import { buildSchedule, defaultSchedule, programPool, slotSourceKey, validateExtraPrograms, validateSeed } from '../server/slotSchedule';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';
import { mixedLineup } from './fixtures';

const SHOW_A = '1aaf2f16-1ead-4fd2-bc7a-bfde35229faf';
const SHOW_B = '2bbf2f16-1ead-4fd2-bc7a-bfde35229faf';
const CUSTOM = '21c65f40-7f21-4f9a-b823-12fecee13788';
const MINUTE = 60_000;

const randomSchedule = () => ({
  type: 'random',
  flexPreference: 'end',
  maxDays: 2,
  padMs: 0,
  padStyle: 'slot',
  randomDistribution: 'weighted',
  lockWeights: false,
  timeZoneOffset: -120,
  slots: [
    { id: 'a0000000-0000-4000-8000-000000000001', type: 'show', showId: SHOW_A, order: 'next', direction: 'asc', weight: 3, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 }, seasonFilter: [], seasonExcludeFilter: [], iterationGroup: 'g1', linkMode: 'continue' },
    { id: 'b0000000-0000-4000-8000-000000000002', type: 'custom-show', customShowId: CUSTOM, order: 'shuffle', direction: 'asc', weight: 1, cooldownMs: 8 * MINUTE, durationSpec: { type: 'dynamic', programCount: 2 } },
    { id: 'c0000000-0000-4000-8000-000000000003', type: 'movie', order: 'shuffle', direction: 'asc', weight: 1, cooldownMs: 0 },
  ],
});

const timeSchedule = () => ({
  type: 'time',
  flexPreference: 'distribute',
  latenessMs: 0,
  maxDays: 7,
  padMs: 1,
  period: 'day',
  timeZoneOffset: 0,
  overflow: { type: 'duration', maxMs: 0 },
  slots: [
    { id: 'd0000000-0000-4000-8000-000000000004', type: 'show', showId: SHOW_A, order: 'next', direction: 'asc', startTime: 18 * 60 * MINUTE },
    { id: 'e0000000-0000-4000-8000-000000000005', type: 'show', showId: SHOW_B, order: 'next', direction: 'asc', startTime: 20 * 60 * MINUTE },
  ],
});

describe('slot schedule validation (server)', () => {
  const FILLER = 'f0000000-0000-4000-8000-0000000000f1';

  it('edits slots and settings, keeping fields Lineup does not manage', () => {
    const current = { ...randomSchedule(), customField: 'kept' };
    const slots = [{ ...current.slots[1], weight: 5, customShow: { name: 'materialized' }, isMissing: false }, current.slots[0]];
    const result = buildSchedule(current, { slots, timeZoneOffset: 60, settings: { maxDays: 7, randomDistribution: 'weighted' } });
    if ('error' in result) throw new Error(result.error);
    expect(result.schedule).toMatchObject({ type: 'random', maxDays: 7, padMs: 0, randomDistribution: 'weighted', timeZoneOffset: 60, customField: 'kept' });
    const saved = result.schedule.slots as Array<Record<string, unknown>>;
    expect(saved.map((slot) => slot.id)).toEqual(['b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001']);
    expect(saved.map((slot) => slot.index)).toEqual([0, 1]);
    expect('customShow' in saved[0] || 'isMissing' in saved[0]).toBe(false);
  });

  it('accepts new sources, and rejects malformed ones', () => {
    const current = randomSchedule();
    const newShow = { ...current.slots[0], showId: SHOW_B };
    expect(buildSchedule(current, { slots: [newShow] })).not.toHaveProperty('error');
    expect(buildSchedule(current, { slots: [{ type: 'redirect', channelId: 'ch-2', channelName: 'Two', weight: 1, cooldownMs: 0 }] })).not.toHaveProperty('error');
    expect(buildSchedule(current, { slots: [{ ...current.slots[1], customShowId: 'not-a-uuid' }] })).toEqual({ error: 'Slot 1 needs a custom show.' });
    expect(buildSchedule(current, { slots: [{ ...current.slots[0], id: 'x' }] })).toEqual({ error: 'Slot 1 is missing its id.' });
    expect(buildSchedule(current, { slots: [{ ...current.slots[0], order: 'random' }] })).toEqual({ error: 'Slot 1 needs a play order.' });
  });

  it('creates and converts schedules from Tunarr’s defaults', () => {
    const created = buildSchedule(undefined, { type: 'time', settings: { period: 'week' }, slots: [{ ...timeSchedule().slots[0], startTime: 6 * DAY_MS }] });
    if ('error' in created) throw new Error(created.error);
    const defaults = Object.fromEntries(Object.entries(defaultSchedule('time')).filter(([key]) => key !== 'slots'));
    expect(created.schedule).toMatchObject({ ...defaults, period: 'week', type: 'time' });
    expect(created.schedule.slots).toHaveLength(1);
    const converted = buildSchedule(randomSchedule(), { type: 'time', slots: [{ ...randomSchedule().slots[0], startTime: 0 }] });
    if ('error' in converted) throw new Error(converted.error);
    const slot = (converted.schedule.slots as Array<Record<string, unknown>>)[0];
    expect(slot.startTime).toBe(0);
    expect('weight' in slot || 'durationSpec' in slot || 'index' in slot).toBe(false);
    expect(buildSchedule(undefined, { slots: [{ type: 'flex' }] })).toEqual({ error: 'Choose a random-slot or time-slot schedule.' });
  });

  it('validates settings per schedule type', () => {
    const random = randomSchedule();
    expect(buildSchedule(random, { slots: random.slots, settings: { period: 'week' } })).toHaveProperty('error');
    expect(buildSchedule(random, { slots: random.slots, settings: { maxDays: 0 } })).toHaveProperty('error');
    const time = timeSchedule();
    expect(buildSchedule(time, { slots: time.slots, settings: { padMs: 0 } })).toHaveProperty('error');
    expect(buildSchedule(time, { slots: time.slots, settings: { overflow: { type: 'oneExtra' }, latenessMs: 300000 } })).not.toHaveProperty('error');
  });

  it('validates slot timing, weights and lengths', () => {
    const random = randomSchedule();
    expect(buildSchedule(random, { slots: [{ ...random.slots[0], weight: -1 }] })).toHaveProperty('error');
    expect(buildSchedule(random, { slots: [{ ...random.slots[0], durationSpec: { type: 'dynamic', programCount: 0 } }] })).toHaveProperty('error');
    expect(buildSchedule(random, { slots: [] })).toHaveProperty('error');
    const time = timeSchedule();
    expect(buildSchedule(time, { slots: [{ ...time.slots[0], startTime: DAY_MS }] })).toHaveProperty('error');
    expect(buildSchedule(time, { slots: [{ ...time.slots[0], startTime: 1.5 }] })).toHaveProperty('error');
    expect(buildSchedule(time, { slots: [time.slots[0], { ...time.slots[1], startTime: time.slots[0].startTime }] })).toEqual({ error: 'Slot 2 starts at the same time as another slot.' });
  });

  it('validates per-slot commercials (filler and mid-roll breaks)', () => {
    const random = randomSchedule();
    const withBreaks = {
      ...random.slots[0],
      filler: [{ types: ['pre', 'post'], fillerListId: FILLER, fillerOrder: 'shuffle_prefer_short' }],
      midRoll: { breakRule: { type: 'fixed_interval', intervalMs: 600000 }, maxBreaks: 3, minProgramDurationMs: 900000, breakDurationMs: 120000, strategy: 'eager' },
    };
    expect(buildSchedule(random, { slots: [withBreaks] })).not.toHaveProperty('error');
    expect(buildSchedule(random, { slots: [{ ...withBreaks, filler: [{ types: [], fillerListId: FILLER }] }] })).toHaveProperty('error');
    expect(buildSchedule(random, { slots: [{ ...withBreaks, midRoll: { maxBreaks: 1, minProgramDurationMs: 0, breakDurationMs: 1 } }] })).toHaveProperty('error');
    expect(buildSchedule(random, { slots: [{ type: 'flex', weight: 1, cooldownMs: 0, filler: withBreaks.filler }] })).toEqual({ error: "Slot 1 can't have commercials of its own." });
    const fillerSlot = { type: 'filler', fillerListId: FILLER, order: 'shuffle_prefer_short', durationWeighting: 'linear', decayFactor: 0.5, recoveryFactor: 0.1, weight: 1, cooldownMs: 0 };
    expect(buildSchedule(random, { slots: [fillerSlot] })).not.toHaveProperty('error');
    expect(buildSchedule(random, { slots: [{ ...fillerSlot, decayFactor: 1 }] })).toHaveProperty('error');
  });

  it('builds the program pool from programs already on the channel, like Tunarr’s editor', () => {
    const lineup = [
      { type: 'content', id: 'ep-a', duration: 1 },
      { type: 'content', id: 'ep-b', duration: 1 },
      { type: 'content', id: 'film', duration: 1 },
      { type: 'custom', id: 'cs-item', customShowId: CUSTOM, duration: 1 },
      { type: 'custom', id: 'other-cs', customShowId: 'nope', duration: 1 },
      { type: 'flex', duration: 1 },
    ];
    const programs = {
      'ep-a': { program: { type: 'episode', show: { uuid: SHOW_A, title: 'A' } } },
      'ep-b': { program: { type: 'episode', season: { show: { uuid: SHOW_B } } } },
      film: { program: { type: 'movie' } },
      'cs-item': { program: { type: 'episode' } },
    };
    const slots = randomSchedule().slots;
    expect(programPool(slots, lineup, programs)).toEqual(['ep-a', 'film', 'cs-item']);
    expect(programPool([{ type: 'show', showId: SHOW_B }], lineup, programs)).toEqual(['ep-b']);
  });

  it('adds requested programs to the pool once', () => {
    expect(programPool([{ type: 'movie' }], [{ type: 'content', id: 'film', duration: 1 }], { film: { program: { type: 'movie' } } }, ['extra-1', 'film', 'extra-1'])).toEqual(['film', 'extra-1']);
    expect(validateExtraPrograms(['not-a-uuid'])).toHaveProperty('error');
    expect(validateExtraPrograms(undefined)).toEqual({ ids: [] });
  });

  it('identifies slot sources and validates seeds', () => {
    expect(slotSourceKey({ type: 'show', showId: 'x' })).toBe('show:x');
    expect(slotSourceKey({ type: 'movie' })).toBe('movie');
    expect(slotSourceKey({ type: 'mystery' })).toBeNull();
    expect(validateSeed([1, 2], 3)).toEqual({ seed: [1, 2], discardCount: 3 });
    expect(validateSeed('x', 1)).toHaveProperty('error');
    expect(validateSeed([1], -1)).toHaveProperty('error');
  });
});

describe('slot schedule routes (proxy)', () => {
  type Call = { url: string; method: string; body?: unknown };
  const harness = (current: Record<string, unknown>) => {
    const calls: Call[] = [];
    const config: ProxyConfig = {
      ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000' }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const url = String(input);
        if (init?.method === 'POST' && /schedule-(time-)?slots$/.test(url)) return Response.json({ startTime: 1, lineup: [], programs: {}, seed: [7, 8], discardCount: 2 });
        if (url.endsWith('/schedule')) return Response.json({ schedule: { ...(current.schedule as object), slots: [] } });
        return Response.json(current);
      }) as typeof fetch,
    };
    return { calls, config };
  };
  const request = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
    method: 'POST',
    url: `/api/tunarr/channels/abc/${path}`,
    headers: { host: 'h', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const lineup = [{ type: 'content', id: 'ep-a', duration: 1 }, { type: 'flex', duration: 1 }];
  const programs = { 'ep-a': { program: { type: 'episode', show: { uuid: SHOW_A } } } };

  it('previews against the right Tunarr endpoint with the merged schedule', async () => {
    const random = harness({ lineup, programs, schedule: randomSchedule() });
    const response = await handleTunarrApi(request('schedule-preview', { slots: randomSchedule().slots.slice(0, 2) }), random.config);
    expect(response.status).toBe(200);
    expect(random.calls.map((call) => `${call.method} ${call.url.replace('http://tunarr:8000', '')}`)).toEqual(['GET /api/channels/abc/programming', 'POST /api/channels/abc/schedule-slots']);
    expect((random.calls[1].body as { schedule: { maxDays: number; slots: unknown[] } }).schedule.maxDays).toBe(2);

    const time = harness({ lineup, programs, schedule: timeSchedule() });
    await handleTunarrApi(request('schedule-preview', { slots: timeSchedule().slots }), time.config);
    expect(time.calls[1].url).toBe('http://tunarr:8000/api/channels/abc/schedule-time-slots');
  });

  it('saves a schedule with a server-computed program pool and the preview’s seed', async () => {
    const current = { lineup, programs, schedule: randomSchedule() };
    const { calls, config } = harness(current);
    const version = programmingVersion(current.lineup, current.schedule);
    const response = await handleTunarrApi(request('programming', { type: 'random', schedule: { slots: randomSchedule().slots }, seed: [7, 8], discardCount: 2, programs: ['injected'] }, { 'if-match': `"${version}"` }), config);
    expect(response.status).toBe(200);
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({ type: 'random', programs: ['ep-a'], seed: [7, 8], discardCount: 2 });
    expect((post.body as { schedule: { maxDays: number } }).schedule.maxDays).toBe(2);
  });

  it('converts a schedule type on save and refuses out-of-date saves', async () => {
    const current = { lineup, programs, schedule: randomSchedule() };
    const version = programmingVersion(current.lineup, current.schedule);
    const save = (body: unknown, ifMatch = version) => {
      const { calls, config } = harness(current);
      return handleTunarrApi(request('programming', body, { 'if-match': `"${ifMatch}"` }), config).then((response) => ({ response, posts: calls.filter((call) => call.method === 'POST') }));
    };
    const converted = await save({ type: 'time', schedule: { slots: timeSchedule().slots, settings: { period: 'day' } } });
    expect(converted.response.status).toBe(200);
    expect((converted.posts[0].body as { type: string; schedule: { type: string } }).schedule.type).toBe('time');
    const badSlot = await save({ type: 'random', schedule: { slots: [{ ...randomSchedule().slots[0], showId: '' }] } });
    expect(badSlot.response.status).toBe(400);
    expect(badSlot.posts).toHaveLength(0);
    const stale = await save({ type: 'random', schedule: { slots: randomSchedule().slots } }, 'stale-version');
    expect(stale.response.status).toBe(412);
    expect(stale.posts).toHaveLength(0);
  });

  it('adds requested programs to the saved pool', async () => {
    const current = { lineup, programs, schedule: randomSchedule() };
    const { calls, config } = harness(current);
    const extra = 'f1111111-0000-4000-8000-000000000001';
    await handleTunarrApi(request('programming', { type: 'random', schedule: { slots: randomSchedule().slots }, extraPrograms: [extra] }, { 'if-match': `"${programmingVersion(current.lineup, current.schedule)}"` }), config);
    expect((calls.find((call) => call.method === 'POST')!.body as { programs: string[] }).programs).toEqual(['ep-a', extra]);
  });

  it('serves the materialized schedule', async () => {
    const { calls, config } = harness({ lineup, programs, schedule: randomSchedule() });
    const response = await handleTunarrApi({ method: 'GET', url: '/api/tunarr/channels/abc/schedule', headers: { host: 'h' } }, config);
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('http://tunarr:8000/api/channels/abc/schedule');
    expect((await handleTunarrApi({ method: 'POST', url: '/api/tunarr/channels/abc/schedule', headers: { host: 'h' } }, config)).status).toBe(405);
  });
});

describe('slot editing helpers (browser)', () => {
  const slots = randomSchedule().slots as Slot[];

  it('offers only sources already in the schedule, plus flex', () => {
    const options = sourceOptions([{ ...slots[0], show: { title: 'Betty' } }, slots[1], slots[2]]);
    expect(options.length).toBe(4);
    expect(new Set(options.map((option) => option.key))).toEqual(new Set([`custom-show:${CUSTOM}`, `show:${SHOW_A}`, 'movie', 'flex']));
    expect(options.at(-1)!.key).toBe('flex');
    expect(options.find((option) => option.key === `show:${SHOW_A}`)!.label).toBe('Betty');
  });

  it('switches a slot’s source but keeps its timing', () => {
    const custom = sourceOptions(slots).find((option) => option.key === `custom-show:${CUSTOM}`)!;
    const switched = changeSlotSource(slots[0], custom);
    expect(switched).toMatchObject({ type: 'custom-show', customShowId: CUSTOM, weight: 3, cooldownMs: 0, id: 'a0000000-0000-4000-8000-000000000001' });
    expect('showId' in switched || 'iterationGroup' in switched).toBe(false);
    const flex = changeSlotSource(slots[0], sourceOptions(slots).at(-1)!);
    expect(flex).toEqual({ type: 'flex', weight: 3, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 } });
  });

  it('duplicates as an independent slot with a fresh id', () => {
    const copy = duplicateSlot(slots[0]);
    expect(copy.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(copy.id).not.toBe(slots[0].id);
    expect('iterationGroup' in copy).toBe(false);
    expect(copy.showId).toBe(SHOW_A);
  });

  it('shifts time slots within the period and flags problems', () => {
    const time = timeSchedule().slots as Slot[];
    const shifted = shiftTimeSlots(time, 5 * 60 * MINUTE, DAY_MS);
    expect(shifted.map((slot) => offsetToClock(Number(slot.startTime)))).toEqual(['01:00:00', '23:00:00']);
    expect(slotProblems({ type: 'time', period: 'day' }, [time[0], { ...time[1], startTime: time[0].startTime }])[1]).toMatch(/same time/);
    expect(slotProblems({ type: 'random' }, [{ ...slots[0], weight: -2 }])[0]).toMatch(/Weight/);
    expect(clockToOffset('18:30')).toBe((18 * 60 + 30) * MINUTE);
    expect(clockToOffset('25:00')).toBeNaN();
    expect(slotWeightShare(slots, 0)).toBeCloseTo(60);
  });
});

describe('persistent drafts', () => {
  const base = mixedLineup();
  const moved = [base[1], base[0], ...base.slice(2)];
  const history: History = record({ past: [], future: [] }, { label: 'Moved', before: base, after: moved, blockBefore: { start: 0, end: 0 }, blockAfter: { start: 1, end: 1 } });

  it('round-trips order and history as positions in the loaded lineup', () => {
    const draft = encodeDraft('ch', 'v1', base, moved, history, true)!;
    expect(draft.current).toEqual([1, 0, 2, 3, 4, 5]);
    const fresh = JSON.parse(JSON.stringify(base)) as LineupItem[];
    const decoded = decodeDraft(draft, fresh)!;
    expect(decoded.current[0]).toBe(fresh[1]);
    expect(decoded.history.past[0].label).toBe('Moved');
    expect(decodeDraft(draft, fresh.slice(1))).toBeNull();
  });

  it('stores drafts in IndexedDB and survives a new store instance', async () => {
    const factory = new IDBFactory();
    const draft = encodeDraft('ch-1', 'v1', base, moved, history, true)!;
    await createDraftStore(factory).put(draft);
    const reopened = createDraftStore(factory);
    expect(reopened.persistent).toBe(true);
    expect((await reopened.get('ch-1'))?.current).toEqual(draft.current);
    await reopened.delete('ch-1');
    expect(await reopened.list()).toEqual([]);
  });

  it('falls back to memory when IndexedDB is unavailable', async () => {
    const store = createDraftStore(undefined);
    expect(store.persistent).toBe(false);
    await store.put(encodeDraft('x', 'v', base, base, { past: [], future: [] }, false)!);
    expect((await store.list()).map((draft) => draft.channelId)).toEqual(['x']);
  });

  it('re-attaches history to the lineup Tunarr returns after a save', () => {
    const fresh = JSON.parse(JSON.stringify(moved)) as LineupItem[];
    const rebased = rebaseHistory(history, moved, fresh)!;
    expect(rebased.past[0].after[0]).toBe(fresh[0]);
    expect(rebased.past[0].before[0]).toBe(fresh[1]);
    expect(rebaseHistory(history, moved, fresh.slice(1))).toBeNull();
    expect(rebaseHistory(history, moved, [...fresh].reverse())).toBeNull();
  });

  it('fingerprints programming deterministically', () => {
    const a = programmingVersion(base, null);
    expect(programmingVersion(JSON.parse(JSON.stringify(base)), undefined)).toBe(a);
    expect(programmingVersion(moved, null)).not.toBe(a);
    expect(programmingVersion(base, { type: 'random' })).not.toBe(a);
  });
});
