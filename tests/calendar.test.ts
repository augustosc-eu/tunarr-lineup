import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { calendarConflicts, CONTINUE_UNSUPPORTED, isTimeZone, localDate, occurrences, outranked, outranks, resumedStartTime, startingLineup, validateCalendarEntry, wallClock, zonedTime, type CalendarEntryInput } from '../server/calendar';
import { armCalendar, CALENDAR_UNRECONCILED, calendarRevision, reconcileCalendar, withCalendarLock } from '../server/calendarArm';
import { StoreError } from '../server/jsonFile';
import { createCalendarStore, createScheduleLibrary } from '../server/calendarStore';
import { programmingVersion } from '../server/lineupVersion';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const P = (n: number) => `0b6f5c4e-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;

describe('time zones and clock changes', () => {
  it('finds the instant of a local time, moving skipped times forward and taking the first repeated one', () => {
    expect(iso(zonedTime(2026, 10, 31, 20, 0, 'Europe/Madrid').at)).toBe('2026-10-31T19:00:00.000Z');
    expect(iso(zonedTime(2026, 7, 31, 20, 0, 'Europe/Madrid').at)).toBe('2026-07-31T18:00:00.000Z');
    // New York springs forward at 02:00 on 8 March 2026: 02:30 doesn't exist.
    expect(zonedTime(2026, 3, 8, 2, 30, 'America/New_York')).toEqual({ at: Date.parse('2026-03-08T07:30:00Z'), adjusted: true });
    // It falls back at 02:00 on 1 November: 01:30 happens twice; the first is EDT.
    expect(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')).toEqual({ at: Date.parse('2026-11-01T05:30:00Z'), adjusted: false });
    expect(iso(zonedTime(2026, 5, 4, 0, 0, 'America/Argentina/Buenos_Aires').at)).toBe('2026-05-04T03:00:00.000Z');
    expect(wallClock(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
    expect(localDate(Date.parse('2026-12-31T23:30:00Z'), 'Asia/Tokyo')).toBe('2027-01-01');
    expect(isTimeZone('Europe/Madrid')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('occurrences', () => {
  const from = Date.UTC(2026, 9, 1);
  const to = Date.UTC(2028, 0, 1);

  it('repeats Halloween, Christmas over New Year and May the 4th every year', () => {
    const halloween = occurrences({ kind: 'yearly', start: { month: 10, day: 31, time: '18:00' }, end: { month: 11, day: 1, time: '06:00' } }, 'Europe/Madrid', [], from, to);
    expect(halloween.map((item) => [iso(item.start), iso(item.end!)])).toEqual([
      ['2026-10-31T17:00:00.000Z', '2026-11-01T05:00:00.000Z'],
      ['2027-10-31T17:00:00.000Z', '2027-11-01T05:00:00.000Z'],
    ]);
    const christmas = occurrences({ kind: 'yearly', start: { month: 12, day: 24, time: '00:00' }, end: { month: 1, day: 6, time: '23:59' } }, 'America/New_York', [], from, to);
    expect(christmas.map((item) => [item.localDate, iso(item.end!)])).toEqual([['2026-12-24', '2027-01-07T04:59:00.000Z'], ['2027-12-24', '2028-01-07T04:59:00.000Z']]);
    const starWars = occurrences({ kind: 'yearly', start: { month: 5, day: 4, time: '00:00' }, end: { month: 5, day: 5, time: '00:00' } }, 'America/Argentina/Buenos_Aires', [], from, to);
    expect(starWars.map((item) => item.localDate)).toEqual(['2027-05-04']);
  });

  it('puts 29 February on the 28th in other years, and drops exceptions', () => {
    const leap = occurrences({ kind: 'yearly', start: { month: 2, day: 29, time: '10:00' }, end: { month: 2, day: 29, time: '12:00' } }, 'UTC', ['2028-02-29'], Date.UTC(2026, 0, 1), Date.UTC(2029, 0, 1));
    expect(leap.map((item) => item.localDate)).toEqual(['2026-02-28', '2027-02-28']);
  });

  it('handles one-time entries with and without an end', () => {
    expect(occurrences({ kind: 'once', start: { date: '2026-11-01', time: '09:00' }, end: null }, 'UTC', [], from, to)).toEqual([{ start: Date.UTC(2026, 10, 1, 9), end: null, localDate: '2026-11-01', adjusted: false }]);
    expect(occurrences({ kind: 'once', start: { date: '2026-01-01', time: '09:00' }, end: { date: '2026-01-02', time: '09:00' } }, 'UTC', [], from, to)).toEqual([]);
  });

  it('keeps weekly times on the local clock across a clock change, past midnight too', () => {
    const late = occurrences({ kind: 'weekly', weekdays: [5], start: '23:00', end: '01:00' }, 'America/New_York', [], Date.UTC(2026, 9, 26), Date.UTC(2026, 10, 10));
    // Fridays 23:00–01:00: EDT before 1 November, EST after.
    expect(late.map((item) => [iso(item.start), iso(item.end!)])).toEqual([
      ['2026-10-31T03:00:00.000Z', '2026-10-31T05:00:00.000Z'],
      ['2026-11-07T04:00:00.000Z', '2026-11-07T06:00:00.000Z'],
    ]);
  });
});

const base = (extra: Partial<CalendarEntryInput> = {}): CalendarEntryInput & { id: string; name: string } => ({
  id: 'a', name: 'Halloween', scheduleId: '11111111-1111-4111-8111-111111111111', channelIds: ['c1'], timeZone: 'UTC', exceptions: [], priority: 5,
  recurrence: { kind: 'yearly', start: { month: 10, day: 31, time: '18:00' }, end: { month: 11, day: 1, time: '06:00' } },
  start: { mode: 'as-is' }, end: 'restore', armLeadMinutes: 360, enabled: true, ...extra,
});

describe('validating calendar entries', () => {
  it('refuses continuing progress, with why', () => {
    expect(validateCalendarEntry({ ...base(), start: { mode: 'continue' } })).toEqual({ error: CONTINUE_UNSUPPORTED });
    expect(CONTINUE_UNSUPPORTED).toContain('Tunarr keeps no episode progress');
  });

  it('asks for an end to restore, and a restore for repeating entries', () => {
    expect(validateCalendarEntry({ ...base(), recurrence: { kind: 'once', start: { date: '2026-11-01', time: '09:00' }, end: null } })).toMatchObject({ error: expect.stringContaining('nothing to restore') });
    expect(validateCalendarEntry({ ...base(), end: 'keep' })).toMatchObject({ error: expect.stringContaining('put the old lineup back') });
    expect(validateCalendarEntry({ ...base(), recurrence: { kind: 'once', start: { date: '2026-11-01', time: '09:00' }, end: null }, end: 'keep' })).toMatchObject({ end: 'keep' });
  });

  it('checks dates, times, zones, priorities and channels', () => {
    expect('error' in validateCalendarEntry({ ...base(), timeZone: 'Nowhere/City' })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), priority: 10 })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), recurrence: { kind: 'yearly', start: { month: 2, day: 30, time: '10:00' }, end: { month: 3, day: 1, time: '10:00' } } })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), recurrence: { kind: 'weekly', weekdays: [7], start: '10:00', end: '11:00' } })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), recurrence: { kind: 'once', start: { date: '2026-11-02', time: '09:00' }, end: { date: '2026-11-01', time: '09:00' } } })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), channelIds: ['../x'] })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), exceptions: ['31/10/2026'] })).toBe(true);
    expect('error' in validateCalendarEntry({ ...base(), armLeadMinutes: 5 })).toBe(true);
  });
});

describe('calendar conflicts and priority', () => {
  const from = Date.UTC(2026, 9, 1);
  const to = from + 400 * 24 * HOUR;
  const spooky = base({ recurrence: { kind: 'yearly', start: { month: 10, day: 25, time: '00:00' }, end: { month: 11, day: 2, time: '00:00' } } });

  it('refuses the same priority overlapping on a shared channel, and lets a higher one win otherwise', () => {
    const halloween = { ...base(), id: 'h' };
    const week = { ...spooky, id: 'w', name: 'Spooky Week' };
    // This year's and next year's overlap.
    expect(calendarConflicts(halloween, [week], from, to).map((item) => item.resolution)).toEqual(['refused', 'refused']);
    expect(calendarConflicts({ ...halloween, priority: 8 }, [week], from, to)[0]).toMatchObject({ resolution: 'this-wins', otherName: 'Spooky Week', channelId: 'c1' });
    expect(calendarConflicts({ ...halloween, priority: 2 }, [week], from, to)[0].resolution).toBe('other-wins');
    expect(calendarConflicts({ ...halloween, channelIds: ['c2'] }, [week], from, to)).toEqual([]);
    expect(calendarConflicts(halloween, [{ ...week, enabled: false }], from, to)).toEqual([]);
    const occurrence = occurrences(halloween.recurrence, 'UTC', [], from, to)[0];
    expect(outranked({ ...halloween, priority: 2 }, occurrence, 'c1', [week])).toBe(true);
    expect(outranked({ ...halloween, priority: 8 }, occurrence, 'c1', [week])).toBe(false);
  });
});

describe('starting and resuming', () => {
  it('turns a lineup to begin at a position', () => {
    expect(startingLineup(['a', 'b', 'c'], { mode: 'position', position: 1 })).toEqual(['b', 'c', 'a']);
    expect(startingLineup(['a', 'b'], { mode: 'position', position: 9 })).toEqual(['b', 'a']);
    expect(startingLineup(['a', 'b'], { mode: 'restart' })).toEqual(['a', 'b']);
  });

  it('works out the start time that resumes an interrupted lineup', () => {
    // 60-minute cycle from 0; interrupted at 10:25 (25 min in); resumed at 18:00 → 25 min in again.
    const resumed = resumedStartTime(0, HOUR, 10 * HOUR + 25 * MIN, 18 * HOUR);
    expect((18 * HOUR - resumed) % HOUR).toBe(25 * MIN);
    expect(resumedStartTime(5, 0, 1, 2)).toBe(5);
  });
});

// ------------------------------------------------------------ with the scheduler

function fakeTunarr() {
  const state = {
    channels: [{ id: 'c1', number: 1, name: 'One', startTime: 0 }, { id: 'c2', number: 2, name: 'Two', startTime: 0 }],
    programming: {
      c1: { lineup: [{ type: 'content', id: P(1), duration: 60 * MIN }], programs: {} },
      c2: { lineup: [{ type: 'content', id: P(1), duration: 60 * MIN }], programs: {}, schedule: { type: 'random', slots: [] } },
    } as Record<string, { lineup: unknown[]; programs: Record<string, unknown>; schedule?: unknown }>,
    down: false,
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/api/channels') return json(state.channels);
    const doc = /^\/api\/channels\/([^/]+)$/.exec(url.pathname);
    if (doc) {
      const channel = state.channels.find((item) => item.id === doc[1])!;
      if (init.method === 'PUT') Object.assign(channel, body);
      return json(channel);
    }
    const programming = /^\/api\/channels\/([^/]+)\/programming$/.exec(url.pathname);
    if (programming) {
      if (init.method === 'POST') state.programming[programming[1]].lineup = body.lineup;
      return json(state.programming[programming[1]]);
    }
    return json({}, 404);
  });
  return { state, fetchImpl };
}

async function setup(scheduler = 'on') {
  const dir = await mkdtemp(path.join(tmpdir(), 'lineup-calendar-'));
  const fake = fakeTunarr();
  // The same object the scheduler was made with (it arms the calendar through it).
  const config: ProxyConfig = createProxyConfig({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://tunarr:8000', LINEUP_SCHEDULER: scheduler });
  config.fetchImpl = fake.fetchImpl as unknown as typeof fetch;
  const overlay = await config.scheduleLibrary!.create({ name: 'Spooky', description: '', tags: ['halloween'], origin: { kind: 'desk', channelName: 'CH 1 One' }, lineup: [{ type: 'content', id: P(2), duration: 30 * MIN }, { type: 'content', id: P(3), duration: 30 * MIN }], programs: {} });
  return { ...fake, config, dir, overlay };
}

const post = (url: string, body: unknown): ProxyRequest => ({ method: 'POST', url, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const request = (method: string, url: string, body?: unknown): ProxyRequest => ({ method, url, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const read = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const localParts = (ms: number) => { const date = new Date(ms); return { date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16) }; };

describe('arming calendar occurrences', () => {
  const NOW = Date.UTC(2026, 9, 31, 12);
  const once = (overlayId: string, extra: Record<string, unknown> = {}) => ({
    name: 'Halloween night', scheduleId: overlayId, channelIds: ['c1'], timeZone: 'UTC', priority: 5, armLeadMinutes: 360,
    recurrence: { kind: 'once', start: localParts(NOW + 2 * HOUR), end: localParts(NOW + 4 * HOUR) }, start: { mode: 'restart' }, end: 'restore', ...extra,
  });

  it('arms within the lead time, goes in from the beginning, and restores the lineup and start time exactly', async () => {
    const { config, state, overlay } = await setup();
    const created = await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id)), config);
    expect(created.status).toBe(201);
    const id = read(created).id;
    // Too early: nothing armed.
    expect(await armCalendar(config, NOW - 5 * HOUR)).toBe(0);
    await config.scheduler!.runDue(NOW);
    const plans = (await config.scheduler!.store.list()).filter((change) => change.calendarId === id);
    expect(plans.map((change) => [change.action.kind, change.at])).toEqual([['lineup', NOW + 2 * HOUR], ['restore', NOW + 4 * HOUR]]);
    expect((await config.calendar!.get(id))!.history[0]).toMatchObject({ status: 'armed', channelId: 'c1' });
    // Armed once only.
    await config.scheduler!.runDue(NOW + MIN);
    expect((await config.scheduler!.store.list()).filter((change) => change.calendarId === id)).toHaveLength(2);

    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    expect(state.channels[0].startTime).toBe(NOW + 2 * HOUR);
    await config.scheduler!.runDue(NOW + 4 * HOUR);
    expect(state.programming.c1.lineup).toEqual([{ type: 'content', id: P(1), duration: 60 * MIN }]);
    expect(state.channels[0].startTime).toBe(0);
  });

  it('resumes the old lineup where it was interrupted', async () => {
    const { config, state, overlay } = await setup();
    state.channels[0].startTime = NOW - 25 * MIN; // 25 minutes into the hour-long cycle at NOW
    const id = read(await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id, { end: 'resume', recurrence: { kind: 'once', start: localParts(NOW), end: localParts(NOW + 2 * HOUR) } })), config)).id;
    await config.scheduler!.runDue(NOW);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 2 * HOUR);
    try {
      await config.scheduler!.runDue(NOW + 2 * HOUR);
    } finally {
      Date.now = realNow;
      vi.restoreAllMocks();
    }
    expect(state.programming.c1.lineup).toEqual([{ type: 'content', id: P(1), duration: 60 * MIN }]);
    // At the end it's 25 minutes into its cycle again.
    expect(((NOW + 2 * HOUR - state.channels[0].startTime) % HOUR + HOUR) % HOUR).toBe(25 * MIN);
    expect((await config.calendar!.get(id))!.history[0].status).toBe('armed');
  });

  it('skips rather than forces when the channel changes after arming', async () => {
    const { config, state, overlay } = await setup();
    await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id)), config);
    await config.scheduler!.runDue(NOW);
    state.programming.c1.lineup = [{ type: 'flex', duration: 10 * MIN }];
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual([{ type: 'flex', duration: 10 * MIN }]);
    const changes = await config.scheduler!.store.list();
    expect(changes.map((change) => change.status)).toEqual(['skipped', 'skipped']);
    expect(changes[0].message).toContain('changed after this was planned');
  });

  it('leaves slot-scheduled channels alone, and an outranked one out', async () => {
    const { config, overlay } = await setup();
    const low = read(await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id, { channelIds: ['c1', 'c2'], priority: 2 })), config)).id;
    const high = read(await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id, { name: 'Big night', priority: 8 })), config)).id;
    await config.scheduler!.runDue(NOW);
    const history = (await config.calendar!.get(low))!.history;
    expect(history.find((record) => record.channelId === 'c1')).toMatchObject({ status: 'suppressed' });
    expect(history.find((record) => record.channelId === 'c2')).toMatchObject({ status: 'skipped', message: expect.stringContaining('slot schedule') });
    expect((await config.calendar!.get(high))!.history[0].status).toBe('armed');
  });

  it('keeps entries and armed plans across a restart', async () => {
    const { config, overlay, dir } = await setup();
    await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id)), config);
    await config.scheduler!.runDue(NOW);
    expect((await createCalendarStore(dir).list())[0].history[0].status).toBe('armed');
    expect((await createScheduleLibrary(dir).list())[0].name).toBe('Spooky');
    const reborn = createProxyConfig({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://tunarr:8000', LINEUP_SCHEDULER: 'on' });
    expect((await reborn.scheduler!.store.list()).filter((change) => change.group === 'calendar')).toHaveLength(2);
  });

  it('removing an entry ends what is on now with its restore, and cancels what it armed', async () => {
    const { config, state, overlay } = await setup();
    const id = read(await handleTunarrApi(post('/api/tunarr/calendar', once(overlay.id, { recurrence: { kind: 'once', start: localParts(Date.now() - HOUR), end: localParts(Date.now() + 5 * HOUR) } })), config)).id;
    await config.scheduler!.runDue(Date.now());
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    const removed = await handleTunarrApi(request('DELETE', `/api/tunarr/calendar/${id}`), config);
    expect(read(removed)).toMatchObject({ removed: true, ending: 1, cancelled: 0 });
    expect(state.programming.c1.lineup).toEqual([{ type: 'content', id: P(1), duration: 60 * MIN }]);
  });
});

describe('re-arming when the calendar changes', () => {
  const NOW = Date.UTC(2026, 9, 31, 12);
  const BIG = [{ type: 'content', id: P(5), duration: 20 * MIN }];
  const entry = (scheduleId: string, startH: number, endH: number, extra: Record<string, unknown> = {}) => ({
    name: 'Low', scheduleId, channelIds: ['c1'], timeZone: 'UTC', priority: 2, armLeadMinutes: 360,
    recurrence: { kind: 'once', start: localParts(NOW + startH * HOUR), end: localParts(NOW + endH * HOUR) }, start: { mode: 'restart' }, end: 'restore', ...extra,
  });
  async function stage() {
    const base = await setup();
    const big = await base.config.scheduleLibrary!.create({ name: 'Big', description: '', tags: [], origin: { kind: 'desk', channelName: '' }, lineup: BIG, programs: {} });
    const add = async (body: unknown) => read(await handleTunarrApi(post('/api/tunarr/calendar', body), base.config)).id as string;
    const put = async (id: string, body: unknown) => handleTunarrApi(request('PUT', `/api/tunarr/calendar/${id}`, body), base.config);
    const plans = async (id: string) => (await base.config.scheduler!.store.list()).filter((change) => change.calendarId === id);
    const pending = async (id: string) => (await plans(id)).filter((change) => change.status === 'pending');
    const status = async (id: string) => (await base.config.calendar!.get(id))!.history.find((record) => record.channelId === 'c1')?.status;
    return { ...base, big, add, put, plans, pending, status };
  }

  it('a higher priority added with the same start, after the lower one was armed, wins', async () => {
    const { config, state, overlay, big, add, pending, status } = await stage();
    const low = await add(entry(overlay.id, 2, 4));
    await config.scheduler!.runDue(NOW);
    expect(await pending(low)).toHaveLength(2);
    const high = await add(entry(big.id, 2, 4, { name: 'High', priority: 8 }));
    await config.scheduler!.runDue(NOW + MIN);
    expect(await pending(low)).toEqual([]);
    expect(await status(low)).toBe('suppressed');
    expect(await status(high)).toBe('armed');
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(BIG);
  });

  it('a higher priority that overlaps only part of an armed lower one still takes the channel', async () => {
    const { config, state, overlay, big, add, pending, status, plans } = await stage();
    const low = await add(entry(overlay.id, 2, 4));
    await config.scheduler!.runDue(NOW);
    const high = await add(entry(big.id, 3, 5, { name: 'High', priority: 8 }));
    await config.scheduler!.runDue(NOW + MIN);
    expect(await pending(low)).toEqual([]);
    expect((await plans(low)).every((change) => change.status === 'cancelled' && change.message?.includes('higher priority'))).toBe(true);
    expect(await status(low)).toBe('suppressed');
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual([{ type: 'content', id: P(1), duration: 60 * MIN }]);
    await config.scheduler!.runDue(NOW + 3 * HOUR);
    expect(state.programming.c1.lineup).toEqual(BIG);
    expect(await status(high)).toBe('armed');
  });

  it('a priority changed after arming moves the channel to the entry that now outranks', async () => {
    const { config, state, overlay, big, add, put, pending, status } = await stage();
    const first = await add(entry(overlay.id, 2, 4, { name: 'First', priority: 5 }));
    const second = await add(entry(big.id, 2, 4, { name: 'Second', priority: 3 }));
    await config.scheduler!.runDue(NOW);
    expect([await status(first), await status(second)]).toEqual(['armed', 'suppressed']);
    expect((await put(second, entry(big.id, 2, 4, { name: 'Second', priority: 8 }))).status).toBe(200);
    // The route already cancelled what no longer holds; the scheduler's run arms the winner.
    expect(await pending(first)).toEqual([]);
    await config.scheduler!.runDue(NOW + MIN);
    expect([await status(first), await status(second)]).toEqual(['suppressed', 'armed']);
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(BIG);
  });

  it('turning off or removing the winner arms the entry it had outranked', async () => {
    for (const how of ['disable', 'remove'] as const) {
      const { config, state, overlay, big, add, put, pending, status } = await stage();
      const winner = await add(entry(big.id, 2, 4, { name: 'Winner', priority: 8 }));
      const loser = await add(entry(overlay.id, 2, 4, { name: 'Loser', priority: 3 }));
      await config.scheduler!.runDue(NOW);
      expect(await status(loser)).toBe('suppressed');
      if (how === 'disable') expect((await put(winner, entry(big.id, 2, 4, { name: 'Winner', priority: 8, enabled: false }))).status).toBe(200);
      else expect((await handleTunarrApi(request('DELETE', `/api/tunarr/calendar/${winner}`), config)).status).toBe(200);
      await config.scheduler!.runDue(NOW + MIN);
      expect([how, await pending(winner)]).toEqual([how, []]);
      expect([how, await status(loser)]).toEqual([how, 'armed']);
      await config.scheduler!.runDue(NOW + 2 * HOUR);
      expect([how, state.programming.c1.lineup]).toEqual([how, overlay.lineup]);
    }
  });

  it('re-arming twice, or after a lost record, never plans an occurrence twice', async () => {
    const { config, overlay, big, add, pending, status } = await stage();
    const low = await add(entry(overlay.id, 2, 4));
    await config.scheduler!.runDue(NOW);
    const high = await add(entry(big.id, 2, 4, { name: 'High', priority: 8 }));
    for (let run = 0; run < 2; run += 1) {
      await reconcileCalendar(config, NOW + MIN);
      await armCalendar(config, NOW + MIN);
    }
    expect(await pending(high)).toHaveLength(2);
    expect(await pending(low)).toEqual([]);
    expect(await reconcileCalendar(config, NOW + MIN)).toBe(0);
    // A record lost (the plan is still there): noted again, not planned twice.
    const key = (await config.calendar!.get(high))!.history[0].key;
    await config.calendar!.release(high, [key]);
    await armCalendar(config, NOW + 2 * MIN);
    expect(await pending(high)).toHaveLength(2);
    expect(await status(high)).toBe('armed');
  });

  it('leaves an occurrence already on air alone, whatever changes in the calendar', async () => {
    const { config, state, overlay, big, add, put, plans } = await stage();
    const active = await add(entry(overlay.id, 0, 3, { name: 'On air', priority: 5 }));
    await config.scheduler!.runDue(NOW);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    // Edited, and outranked from 1 h on, while it airs.
    expect((await put(active, entry(overlay.id, 0, 6, { name: 'On air', priority: 5 }))).status).toBe(200);
    await add(entry(big.id, 1, 2, { name: 'High', priority: 8 }));
    await config.scheduler!.runDue(NOW + MIN);
    const mine = await plans(active);
    expect(mine.map((change) => [change.action.kind, change.status])).toEqual([['lineup', 'done'], ['restore', 'pending']]);
    expect(mine[1].at).toBe(NOW + 3 * HOUR);
  });

  it('breaks a tie between equal priorities the same way every time', () => {
    const base = { channelIds: ['c1'], recurrence: { kind: 'once' as const, start: { date: '2026-10-31', time: '18:00' }, end: { date: '2026-10-31', time: '20:00' } }, timeZone: 'UTC', exceptions: [], priority: 5, enabled: true, name: 'x' };
    const older = { ...base, id: 'b', createdAt: 1 };
    const newer = { ...base, id: 'a', createdAt: 2 };
    expect(outranks(older, newer)).toBe(true);
    expect(outranks(newer, older)).toBe(false);
    expect(outranks({ ...base, id: 'a', createdAt: 1 }, { ...base, id: 'b', createdAt: 1 })).toBe(true);
    const [occurrence] = occurrences(base.recurrence, 'UTC', [], 0, Date.UTC(2027, 0, 1));
    expect(outranked(newer, occurrence, 'c1', [older, newer])).toBe(true);
    expect(outranked(older, occurrence, 'c1', [newer, older])).toBe(false);
  });
});

describe('failing closed when the calendar can’t be reconciled', () => {
  const NOW = Date.UTC(2026, 9, 31, 12);
  const BIG = [{ type: 'content', id: P(5), duration: 20 * MIN }];
  const ORIGINAL = [{ type: 'content', id: P(1), duration: 60 * MIN }];
  const entry = (scheduleId: string, startH: number, endH: number, extra: Record<string, unknown> = {}) => ({
    name: 'Low', scheduleId, channelIds: ['c1'], timeZone: 'UTC', priority: 2, armLeadMinutes: 360,
    recurrence: { kind: 'once', start: localParts(NOW + startH * HOUR), end: localParts(NOW + endH * HOUR) }, start: { mode: 'restart' }, end: 'restore', ...extra,
  });
  async function stage() {
    const base = await setup();
    const big = await base.config.scheduleLibrary!.create({ name: 'Big', description: '', tags: [], origin: { kind: 'desk', channelName: '' }, lineup: BIG, programs: {} });
    const add = async (body: unknown) => handleTunarrApi(post('/api/tunarr/calendar', body), base.config);
    const put = async (id: string, body: unknown) => handleTunarrApi(request('PUT', `/api/tunarr/calendar/${id}`, body), base.config);
    const plans = async (id: string) => (await base.config.scheduler!.store.list()).filter((change) => change.calendarId === id);
    const saves = () => base.fetchImpl.mock.calls.filter(([url, init]) => String(url).endsWith('/programming') && (init as RequestInit | undefined)?.method === 'POST').length;
    // Cancelling a plan fails: exactly what reconciling a stale one needs.
    const breakCancel = () => vi.spyOn(base.config.scheduler!.store, 'cancel').mockRejectedValue(new StoreError(500, 'store_unreadable', 'scheduled.json can’t be written.'));
    return { ...base, big, add, put, plans, saves, breakCancel };
  }

  it('never applies a plan it couldn’t check, keeps it pending, and goes on once it can', async () => {
    const { config, state, overlay, add, put, plans, saves, breakCancel } = await stage();
    const id = read(await add(entry(overlay.id, 2, 4))).id;
    await config.scheduler!.runDue(NOW);
    expect((await plans(id)).map((change) => change.status)).toEqual(['pending', 'pending']);
    const broken = breakCancel();
    // Turned off: the armed plan is now stale, and reconciling can't cancel it.
    const edited = await put(id, entry(overlay.id, 2, 4, { enabled: false }));
    expect(edited.status).toBe(200);
    expect(read(edited)).toMatchObject({ enabled: false, reconciled: false, warning: CALENDAR_UNRECONCILED });
    for (const at of [NOW + 2 * HOUR, NOW + 2 * HOUR + MIN]) {
      expect(await config.scheduler!.runDue(at)).toBe(0);
      expect(state.programming.c1.lineup).toEqual(ORIGINAL);
    }
    expect(saves()).toBe(0);
    const [start] = await plans(id);
    expect(start).toMatchObject({ status: 'pending', held: true, message: expect.stringContaining('calendar couldn’t be checked') });
    broken.mockRestore();
    await config.scheduler!.runDue(NOW + 2 * HOUR + 2 * MIN);
    expect((await plans(id)).map((change) => change.status)).toEqual(['cancelled', 'cancelled']);
    expect(saves()).toBe(0);
    expect(state.programming.c1.lineup).toEqual(ORIGINAL);
  });

  it('a plan held only because the calendar couldn’t be read goes in once it can be', async () => {
    const { config, state, overlay, add, plans } = await stage();
    const id = read(await add(entry(overlay.id, 2, 4))).id;
    await config.scheduler!.runDue(NOW);
    const broken = vi.spyOn(config.calendar!, 'list').mockRejectedValue(new StoreError(500, 'store_unreadable', 'calendar.json can’t be read.'));
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(ORIGINAL);
    expect((await plans(id))[0]).toMatchObject({ status: 'pending', held: true });
    broken.mockRestore();
    await config.scheduler!.runDue(NOW + 2 * HOUR + MIN);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    const [start] = await plans(id);
    expect(start.status).toBe('done');
    expect(start.held).toBeUndefined();
  });

  it('a new entry that outranks an armed one, saved while reconciling fails, still wins', async () => {
    const { config, state, overlay, big, add, plans, saves, breakCancel } = await stage();
    const low = read(await add(entry(overlay.id, 2, 4))).id;
    await config.scheduler!.runDue(NOW);
    const broken = breakCancel();
    const created = await add(entry(big.id, 2, 4, { name: 'High', priority: 8 }));
    // Saved (201, not an error to retry), and says it isn't reconciled yet.
    expect(created.status).toBe(201);
    expect(read(created)).toMatchObject({ name: 'High', reconciled: false, warning: CALENDAR_UNRECONCILED });
    expect(await config.calendar!.list()).toHaveLength(2);
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(saves()).toBe(0);
    broken.mockRestore();
    await config.scheduler!.runDue(NOW + 2 * HOUR + MIN);
    expect((await plans(low)).map((change) => change.status)).toEqual(['cancelled', 'cancelled']);
    await config.scheduler!.runDue(NOW + 2 * HOUR + 2 * MIN);
    expect(state.programming.c1.lineup).toEqual(BIG);
  });

  it('an edit that reconciles says so', async () => {
    const { overlay, add, put } = await stage();
    const created = await add(entry(overlay.id, 2, 4));
    expect(read(created).reconciled).toBe(true);
    expect(read(await put(read(created).id, entry(overlay.id, 2, 5))).reconciled).toBe(true);
  });

  it('an edit landing after arming but before the change goes in cancels it instead', async () => {
    const { config, state, overlay, add, plans, saves } = await stage();
    const id = read(await add(entry(overlay.id, 2, 4))).id;
    await config.scheduler!.runDue(NOW);
    // The run's arming reads the calendar (first its reconcile, then its entries); the entry is turned off right after that, before anything due is applied.
    const list = config.calendar!.list.bind(config.calendar);
    let calls = 0;
    const spy = vi.spyOn(config.calendar!, 'list').mockImplementation(async () => {
      calls += 1;
      const entries = await list();
      if (calls === 2) await withCalendarLock(async () => { await config.calendar!.update(id, { ...entries[0], enabled: false }); });
      return entries;
    });
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    spy.mockRestore();
    expect(saves()).toBe(0);
    expect(state.programming.c1.lineup).toEqual(ORIGINAL);
    expect((await plans(id))[0]).toMatchObject({ status: 'cancelled', message: expect.stringContaining('turned off') });
  });

  it('an edit sent while an occurrence is going in waits for it, then leaves the started occurrence alone', async () => {
    const { config, fetchImpl, state, overlay, add, put, plans } = await stage();
    const id = read(await add(entry(overlay.id, 2, 4))).id;
    await config.scheduler!.runDue(NOW);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let saving!: () => void;
    const started = new Promise<void>((resolve) => { saving = resolve; });
    const real = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/programming') && init?.method === 'POST') { saving(); await gate; }
      return real(input, init);
    });
    const run = config.scheduler!.runDue(NOW + 2 * HOUR);
    await started;
    let answered = false;
    const edit = put(id, entry(overlay.id, 2, 4, { enabled: false })).then((response) => { answered = true; return response; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answered).toBe(false);
    } finally {
      release();
      await run;
    }
    expect((await edit).status).toBe(200);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    // On air: its restore stays planned, untouched by the edit.
    expect((await plans(id)).map((change) => [change.action.kind, change.status])).toEqual([['lineup', 'done'], ['restore', 'pending']]);
  });
});

describe('the revision an occurrence is armed with', () => {
  const NOW = Date.UTC(2026, 9, 31, 12);
  const entry = (scheduleId: string, extra: Record<string, unknown> = {}) => ({
    name: 'Halloween', scheduleId, channelIds: ['c1'], timeZone: 'UTC', priority: 5, armLeadMinutes: 24 * 60,
    recurrence: { kind: 'once', start: localParts(NOW + 2 * HOUR), end: localParts(NOW + 4 * HOUR) }, start: { mode: 'restart' }, end: 'restore', ...extra,
  });
  const pendingOf = async (config: ProxyConfig, id: string) => (await config.scheduler!.store.list()).filter((change) => change.calendarId === id && change.status === 'pending');

  it('covers the lead time and the name, not the per-channel checks', () => {
    const one = { ...entry('s'), exceptions: [], enabled: true, id: 'x', createdAt: 0, updatedAt: 0, history: [] } as unknown as Parameters<typeof calendarRevision>[0];
    expect(calendarRevision({ ...one, armLeadMinutes: 15 })).not.toBe(calendarRevision(one));
    expect(calendarRevision({ ...one, name: 'Renamed' })).not.toBe(calendarRevision(one));
    expect(calendarRevision({ ...one, priority: 9, enabled: false, channelIds: ['c2'] })).toBe(calendarRevision(one));
  });

  it('shortening the lead from a day to 15 minutes un-arms the plan until the new window', async () => {
    const { config, state, overlay } = await setup();
    const id = read(await handleTunarrApi(post('/api/tunarr/calendar', entry(overlay.id)), config)).id;
    await config.scheduler!.runDue(NOW);
    const [armed] = await pendingOf(config, id);
    expect(armed.occurrence!.revision).toBeTruthy();
    expect((await handleTunarrApi(request('PUT', `/api/tunarr/calendar/${id}`, entry(overlay.id, { armLeadMinutes: 15 })), config)).status).toBe(200);
    expect(await pendingOf(config, id)).toEqual([]);
    expect((await config.calendar!.get(id))!.history).toEqual([]);
    // Outside the new window: not armed again.
    await config.scheduler!.runDue(NOW + HOUR);
    expect(await pendingOf(config, id)).toEqual([]);
    // Inside it: armed again, from the channel as it is then, with the new revision.
    state.programming.c1.lineup = [{ type: 'content', id: P(7), duration: 60 * MIN }];
    await config.scheduler!.runDue(NOW + 2 * HOUR - 10 * MIN);
    const again = await pendingOf(config, id);
    expect(again).toHaveLength(2);
    expect(again[0].occurrence!.revision).not.toBe(armed.occurrence!.revision);
    expect(again[0].occurrence!.revision).toBe(calendarRevision((await config.calendar!.get(id))!));
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
  });

  it('renaming re-plans what hasn’t started, so labels never keep the old name', async () => {
    const { config, overlay } = await setup();
    const id = read(await handleTunarrApi(post('/api/tunarr/calendar', entry(overlay.id)), config)).id;
    await config.scheduler!.runDue(NOW);
    expect((await pendingOf(config, id)).map((change) => change.label)).toEqual(['Halloween', 'Halloween ends']);
    await handleTunarrApi(request('PUT', `/api/tunarr/calendar/${id}`, entry(overlay.id, { name: 'All Hallows' })), config);
    await config.scheduler!.runDue(NOW + MIN);
    expect((await pendingOf(config, id)).map((change) => change.label)).toEqual(['All Hallows', 'All Hallows ends']);
  });

  it('a started occurrence keeps its plan when the lead or name changes', async () => {
    const { config, state, overlay } = await setup();
    const id = read(await handleTunarrApi(post('/api/tunarr/calendar', entry(overlay.id)), config)).id;
    await config.scheduler!.runDue(NOW);
    await config.scheduler!.runDue(NOW + 2 * HOUR);
    expect(state.programming.c1.lineup).toEqual(overlay.lineup);
    await handleTunarrApi(request('PUT', `/api/tunarr/calendar/${id}`, entry(overlay.id, { name: 'Renamed', armLeadMinutes: 15 })), config);
    await config.scheduler!.runDue(NOW + 2 * HOUR + MIN);
    const mine = (await config.scheduler!.store.list()).filter((change) => change.calendarId === id);
    expect(mine.map((change) => [change.action.kind, change.status, change.label])).toEqual([['lineup', 'done', 'Halloween'], ['restore', 'pending', 'Halloween ends']]);
    await config.scheduler!.runDue(NOW + 4 * HOUR);
    expect(state.programming.c1.lineup).toEqual([{ type: 'content', id: P(1), duration: 60 * MIN }]);
  });
});

describe('library and calendar routes', () => {
  it('saves schedules, refuses deleting one the calendar uses, and previews conflicts before saving', async () => {
    const { config, overlay } = await setup('off');
    expect((await handleTunarrApi(post('/api/tunarr/schedule-library', { name: '', origin: { kind: 'desk' }, lineup: [] }), config)).status).toBe(400);
    const saved = await handleTunarrApi(post('/api/tunarr/schedule-library', { name: 'Christmas', tags: ['xmas'], origin: { kind: 'slot-preview', channelName: 'CH 1' }, lineup: [{ type: 'content', id: P(4), duration: MIN }], programs: { [P(4)]: { title: 'Carol', artwork: 'http://10.0.0.1/x?X-Plex-Token=t' } } }), config);
    expect(read(saved)).toMatchObject({ name: 'Christmas', items: 1, length: MIN, tags: ['xmas'] });
    const full = read(await handleTunarrApi(request('GET', `/api/tunarr/schedule-library/${read(saved).id}`), config));
    expect(full.programs).toEqual({ [P(4)]: { title: 'Carol' } });

    const entry = { name: 'Halloween', scheduleId: overlay.id, channelIds: ['c1'], timeZone: 'Europe/Madrid', recurrence: { kind: 'yearly', start: { month: 10, day: 31, time: '18:00' }, end: { month: 11, day: 1, time: '06:00' } }, start: { mode: 'as-is' }, end: 'restore' };
    const preview = read(await handleTunarrApi(post('/api/tunarr/calendar/preview', entry), config));
    expect(preview.next.length).toBeGreaterThan(0);
    expect(preview.warnings[0]).toContain('Scheduled changes are off');
    expect((await handleTunarrApi(post('/api/tunarr/calendar', entry), config)).status).toBe(201);
    const clash = await handleTunarrApi(post('/api/tunarr/calendar', { ...entry, name: 'Spooky week', recurrence: { kind: 'yearly', start: { month: 10, day: 25, time: '00:00' }, end: { month: 11, day: 2, time: '00:00' } } }), config);
    expect(clash.status).toBe(409);
    expect(read(clash).error.conflicts[0]).toMatchObject({ resolution: 'refused', otherName: 'Halloween' });
    expect((await handleTunarrApi(post('/api/tunarr/calendar', { ...entry, name: 'Spooky week', priority: 7, recurrence: { kind: 'yearly', start: { month: 10, day: 25, time: '00:00' }, end: { month: 11, day: 2, time: '00:00' } } }), config)).status).toBe(201);

    const used = await handleTunarrApi(request('DELETE', `/api/tunarr/schedule-library/${overlay.id}`), config);
    expect(used.status).toBe(409);
    const list = read(await handleTunarrApi(request('GET', '/api/tunarr/calendar'), config));
    expect(list).toMatchObject({ enabled: false, entries: [expect.objectContaining({ name: 'Halloween', scheduleName: 'Spooky' }), expect.objectContaining({ name: 'Spooky week' })] });
  });

  it('never lets the browser plan a calendar occurrence directly', async () => {
    const { config } = await setup();
    const response = await handleTunarrApi(post('/api/tunarr/scheduled', { group: 'calendar', changes: [{ channelId: 'c1', label: 'x', at: Date.now() + HOUR, action: { kind: 'lineup', lineup: [{ type: 'flex', duration: MIN }], expectVersion: programmingVersion([], undefined), startAt: 0 } }] }), config);
    expect(response.status).toBe(400);
    const moved = await handleTunarrApi(post('/api/tunarr/scheduled', { group: 'save', changes: [{ channelId: 'c1', label: 'x', at: Date.now() + HOUR, action: { kind: 'lineup', lineup: [{ type: 'flex', duration: MIN }], expectVersion: 'abc', startAt: 0 } }] }), config);
    expect(read(moved).error.message).toContain('Only calendar occurrences');
  });
});
