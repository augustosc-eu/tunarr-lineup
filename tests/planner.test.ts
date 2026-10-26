import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { programmingVersion } from '../server/lineupVersion';
import { createProxyConfig, handleTunarrApi } from '../server/tunarrProxy';
import { daypartAt, episodeOrder, MAX_PLAN_AIRINGS, MIN_FLEX_MS, planSaveBlocked, planSchedule, seededRandom, type Daypart, type PlannerProgram, type PlannerSettings, type PlannerSource, type SourceRule } from '../lib/planner';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 2, 0); // a Monday, 00:00 UTC

const show = (id: string, seasons: number, episodes: number, minutes: number, genres = ['Comedy']): PlannerSource => ({
  id, label: id,
  programs: Array.from({ length: seasons * episodes }, (_, index) => ({ id: `${id}-${index}`, duration: minutes * MIN, title: `${id} ${index}`, season: Math.floor(index / episodes) + 1, episode: (index % episodes) + 1, genres, type: 'episode' })),
});
const rule = (sourceId: string, extra: Partial<SourceRule> = {}): SourceRule => ({ sourceId, weight: 1, order: 'episode', start: null, maxRepeats: null, cooldownMs: 0, ...extra });
const settings = (rules: SourceRule[], extra: Partial<PlannerSettings> = {}): PlannerSettings => ({ seed: 'abc', start: START, days: 1, balance: 'duration', rules, dayparts: [], timeZone: 'UTC', ...extra });

/** The invariants every plan keeps, whatever its rules. */
function checkInvariants(sources: PlannerSource[], config: PlannerSettings) {
  const plan = planSchedule(sources, config);
  // Contiguous from the start, covering the whole span (the last program may run past it).
  expect(plan.airings[0]?.start).toBe(config.start);
  for (let index = 1; index < plan.airings.length; index += 1) expect(plan.airings[index].start).toBe(plan.airings[index - 1].stop);
  expect(plan.airings.at(-1)!.stop).toBeGreaterThanOrEqual(plan.end);
  expect(plan.airings.at(-2)?.stop ?? config.start).toBeLessThan(plan.end);
  // A complete plan; flex never runs from one daypart into another.
  expect(plan.truncated).toBeNull();
  for (const airing of plan.airings.filter((item) => !item.sourceId)) expect(daypartAt(config.dayparts, airing.stop - 1, config.timeZone)?.id).toBe(daypartAt(config.dayparts, airing.start, config.timeZone)?.id);
  // Items are exactly the airings.
  expect(plan.items.map((item) => item.duration)).toEqual(plan.airings.map((airing) => airing.stop - airing.start));
  // Repeat limits and cooldowns hold.
  for (const r of config.rules) {
    const mine = plan.airings.filter((airing) => airing.sourceId === r.sourceId);
    const counts = new Map<string, number[]>();
    for (const airing of mine) counts.set(airing.programId!, [...(counts.get(airing.programId!) ?? []), airing.start]);
    for (const [, starts] of counts) {
      if (r.maxRepeats !== null) expect(starts.length).toBeLessThanOrEqual(r.maxRepeats);
      const program = sources.find((source) => source.id === r.sourceId)!.programs.find((item) => mine.some((airing) => airing.start === starts[0] && airing.programId === item.id))!;
      for (let index = 1; index < starts.length; index += 1) expect(starts[index] - (starts[index - 1] + program.duration)).toBeGreaterThanOrEqual(r.cooldownMs);
    }
  }
  // Inside a daypart, only sources with a weight there air.
  for (const airing of plan.airings) {
    if (!airing.sourceId) continue;
    const part = daypartAt(config.dayparts, airing.start, config.timeZone);
    const weight = part ? part.weights[airing.sourceId] ?? 0 : config.rules.find((r) => r.sourceId === airing.sourceId)!.weight;
    expect(weight).toBeGreaterThan(0);
  }
  return plan;
}

describe('the planner', () => {
  it('is deterministic for a seed, and a different seed can change ties and shuffles', () => {
    const sources = [show('A', 2, 10, 30), show('B', 1, 12, 30)];
    const config = settings([rule('A', { order: 'shuffle' }), rule('B')]);
    expect(planSchedule(sources, config)).toEqual(planSchedule(sources, config));
    expect(planSchedule(sources, { ...config, seed: 'other' }).items).not.toEqual(planSchedule(sources, config).items);
  });

  it('shares airtime by weight when balancing time, within one program', () => {
    const sources = [show('A', 5, 20, 30), show('B', 5, 20, 60)];
    const plan = checkInvariants(sources, settings([rule('A', { weight: 3 }), rule('B', { weight: 1 })], { days: 7 }));
    const [a, b] = plan.summary.sources;
    expect(a.target).toBe(0.75);
    expect(Math.abs(a.duration - 3 * b.duration)).toBeLessThanOrEqual(2 * HOUR);
    expect(Math.abs(a.share - 0.75)).toBeLessThan(0.02);
  });

  it('shares programs by weight when balancing counts, whatever their lengths', () => {
    const sources = [show('A', 5, 20, 30), show('B', 5, 20, 90)];
    const plan = checkInvariants(sources, settings([rule('A', { weight: 1 }), rule('B', { weight: 1 })], { days: 3, balance: 'count' }));
    const [a, b] = plan.summary.sources;
    expect(Math.abs(a.count - b.count)).toBeLessThanOrEqual(1);
    // Equal counts of unequal lengths: airtime is 1:3, as the summary shows.
    expect(b.duration).toBeGreaterThan(2.5 * a.duration);
  });

  it('starts series at S01E01, or a chosen episode, and keeps episode order while alternating shows', () => {
    const sources = [show('A', 2, 5, 30), show('B', 2, 5, 30)];
    const plan = checkInvariants(sources, settings([rule('A'), rule('B', { start: { season: 2, episode: 3 } })]));
    const a = plan.airings.filter((airing) => airing.sourceId === 'A').map((airing) => Number(airing.programId!.split('-')[1]));
    const b = plan.airings.filter((airing) => airing.sourceId === 'B').map((airing) => Number(airing.programId!.split('-')[1]));
    expect(a.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(b.slice(0, 4)).toEqual([7, 8, 9, 0]);
    // They alternate (equal weights, equal lengths).
    expect(plan.airings.slice(0, 6).map((airing) => airing.sourceId).join('')).toMatch(/^(AB){3}$|^(BA){3}$/);
  });

  it('plays a whole season of one show before moving on (season blocks)', () => {
    const sources = [show('A', 2, 4, 30), show('B', 2, 4, 30)];
    const plan = checkInvariants(sources, settings([rule('A', { order: 'season-block' }), rule('B', { order: 'season-block' })]));
    const runs = plan.airings.slice(0, 16).map((airing) => airing.sourceId).join('').match(/(.)\1*/g)!;
    expect(runs.slice(0, 4).every((run) => run.length === 4)).toBe(true);
  });

  it('respects repeat limits and warns when a source runs out', () => {
    const sources = [show('A', 1, 3, 60), show('B', 3, 10, 60)];
    const plan = checkInvariants(sources, settings([rule('A', { maxRepeats: 1 }), rule('B')]));
    expect(plan.airings.filter((airing) => airing.sourceId === 'A')).toHaveLength(3);
    expect(plan.warnings.some((warning) => warning.startsWith('“A” ran out at'))).toBe(true);
  });

  it('keeps cooldowns, filling with flex when nothing may air yet, and says so', () => {
    const sources = [show('A', 1, 2, 60)];
    const plan = checkInvariants(sources, settings([rule('A', { cooldownMs: 3 * HOUR })]));
    expect(plan.summary.flex).toBeGreaterThan(0);
    expect(plan.items.some((item) => item.type === 'flex')).toBe(true);
    expect(plan.warnings.some((warning) => warning.includes('minutes of flex time'))).toBe(true);
  });

  it('follows dayparts and weekday/weekend rules, in the plan’s time zone', () => {
    const sources = [show('Kids', 4, 20, 30, ['Animation']), show('Late', 4, 20, 60, ['Drama'])];
    const dayparts: Daypart[] = [
      { id: 'morning', label: 'Weekend mornings', from: '06:00', to: '12:00', days: 'weekend', weights: { Kids: 1 } },
      { id: 'night', label: 'Nights', from: '22:00', to: '02:00', days: 'all', weights: { Late: 1 } },
    ];
    const plan = checkInvariants(sources, settings([rule('Kids'), rule('Late')], { days: 7, dayparts, timeZone: 'Europe/Madrid' }));
    const madridHour = (ms: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
    const nights = plan.airings.filter((airing) => airing.sourceId && (madridHour(airing.start) >= 22 || madridHour(airing.start) < 2));
    expect(nights.every((airing) => airing.sourceId === 'Late')).toBe(true);
    expect(plan.summary.genres.map((genre) => genre.name).sort()).toEqual(['Animation', 'Drama']);
    expect(daypartAt(dayparts, Date.UTC(2026, 10, 7, 8), 'Europe/Madrid')?.id).toBe('morning'); // Saturday 09:00 in Madrid
    expect(daypartAt(dayparts, Date.UTC(2026, 10, 6, 8), 'Europe/Madrid')).toBeNull(); // Friday
  });

  it('fills a daypart nobody may air in with flex, and explains it', () => {
    const sources = [show('A', 2, 10, 30)];
    const plan = checkInvariants(sources, settings([rule('A')], { dayparts: [{ id: 'x', label: 'Dead air', from: '03:00', to: '05:00', days: 'all', weights: {} }] }));
    expect(plan.warnings).toContain('No source has a weight in “Dead air”, so it fills with flex time.');
    expect(plan.summary.flex).toBeGreaterThanOrEqual(2 * HOUR - 30 * MIN);
  });

  it('flags sources that can never air', () => {
    const plan = planSchedule([show('A', 1, 2, 30), { id: 'E', label: 'Empty', programs: [] }, show('Z', 1, 2, 30)], settings([rule('A'), rule('E'), rule('Z', { weight: 0 })]));
    expect(plan.warnings).toEqual(expect.arrayContaining(['“Empty” has no programs with a length, so it never airs.', '“Z” has a weight of 0 everywhere, so it never airs.']));
  });

  it('orders episodes by season and number, unnumbered last', () => {
    const list: PlannerProgram[] = [{ id: 'c', duration: 1, title: 'c', genres: [], type: 'episode' }, { id: 'b', duration: 1, title: 'b', season: 2, episode: 1, genres: [], type: 'episode' }, { id: 'a', duration: 1, title: 'a', season: 1, episode: 9, genres: [], type: 'episode' }];
    expect(episodeOrder(list).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps every invariant across hundreds of generated plans', () => {
    const random = seededRandom('property');
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
    for (let round = 0; round < 150; round += 1) {
      const count = 1 + Math.floor(random() * 4);
      const sources = Array.from({ length: count }, (_, index) => show(`S${index}`, 1 + Math.floor(random() * 3), 1 + Math.floor(random() * 12), pick([5, 22, 30, 44, 60, 95])));
      const rules = sources.map((source) => rule(source.id, {
        weight: pick([0.5, 1, 2, 3]), order: pick(['episode', 'season-block', 'shuffle'] as const),
        maxRepeats: pick([null, null, 1, 2, 5]), cooldownMs: pick([0, 0, 2 * HOUR, 6 * HOUR]),
        start: random() < 0.3 ? { season: 1, episode: 1 + Math.floor(random() * 3) } : null,
      }));
      const dayparts: Daypart[] = random() < 0.4 ? [{ id: 'p', label: 'Part', from: pick(['06:00', '18:00', '22:00']), to: pick(['10:00', '23:00', '02:00']), days: pick(['all', 'weekdays', 'weekend'] as const), weights: { [sources[0].id]: 1 } }] : [];
      const config = settings(rules, { seed: `round-${round}`, days: 1 + Math.floor(random() * 3), balance: pick(['duration', 'count'] as const), dayparts, timeZone: pick(['UTC', 'America/New_York', 'Asia/Tokyo']) });
      const plan = checkInvariants(sources, config);
      expect(planSchedule(sources, config).items).toEqual(plan.items);
    }
  });

  it('never passes off a plan the airing limit cut short as complete', () => {
    const tiny = (length: number): PlannerSource => ({ id: 'T', label: 'Tiny', programs: [{ id: 't', duration: length, title: 't', genres: [], type: 'clip' }] });
    // Under the limit: complete.
    expect(planSchedule([tiny(HOUR)], settings([rule('T')])).truncated).toBeNull();
    // Exactly the limit, ending exactly at the end: complete.
    const exact = planSchedule([tiny(DAY / MAX_PLAN_AIRINGS)], settings([rule('T')]));
    expect(exact.airings).toHaveLength(MAX_PLAN_AIRINGS);
    expect(exact.truncated).toBeNull();
    expect(exact.end).toBe(START + DAY);
    expect(planSaveBlocked(exact, 'UTC')).toBeNull();
    // One millisecond shorter needs more than the limit: refused, and the end is where it really stopped.
    const cut = planSchedule([tiny(DAY / MAX_PLAN_AIRINGS - 1)], settings([rule('T')]));
    expect(cut.airings).toHaveLength(MAX_PLAN_AIRINGS);
    expect(cut.truncated).toEqual({ requestedEnd: START + DAY, reachedAt: cut.airings.at(-1)!.stop, limit: MAX_PLAN_AIRINGS });
    expect(cut.end).toBe(cut.airings.at(-1)!.stop);
    expect(cut.end).toBeLessThan(START + DAY);
    expect(cut.warnings[0]).toMatch(/^Incomplete: the plan reached its limit of 50,000 programs/);
    expect(planSaveBlocked(cut, 'UTC')).toContain('can’t be saved');
  });

  describe('daypart boundaries', () => {
    const one = (id: string, minutes: number): PlannerSource => ({ id, label: id, programs: [{ id: `${id}-1`, duration: minutes * MIN, title: id, genres: [], type: 'program' }] });
    /** Every whole minute a flex airing covers is in the daypart it started in (an exact scan, independent of the planner's boundaries). */
    const flexStaysInItsDaypart = (plan: ReturnType<typeof planSchedule>, dayparts: Daypart[], timeZone: string) => {
      for (const airing of plan.airings.filter((item) => !item.sourceId)) {
        const part = daypartAt(dayparts, airing.start, timeZone)?.id ?? null;
        for (let at = Math.ceil((airing.start + 1) / MIN) * MIN; at < airing.stop; at += MIN) expect([airing.start, at, daypartAt(dayparts, at, timeZone)?.id ?? null]).toEqual([airing.start, at, part]);
      }
    };

    it('changes at 08:03 exactly, filling a gap shorter than the minimum flex only up to it', () => {
      const dayparts: Daypart[] = [{ id: 'quiet', label: 'Quiet', from: '00:00', to: '08:03', days: 'all', weights: {} }, { id: 'news', label: 'News', from: '08:03', to: '12:00', days: 'all', weights: { News: 1 } }];
      const plan = planSchedule([one('News', 30)], settings([rule('News')], { start: START + 8 * HOUR, dayparts, days: 1 }));
      expect(plan.airings[0]).toMatchObject({ start: START + 8 * HOUR, stop: START + 8 * HOUR + 3 * MIN, sourceId: null });
      expect(3 * MIN).toBeLessThan(MIN_FLEX_MS);
      expect(plan.airings[1]).toMatchObject({ start: START + 8 * HOUR + 3 * MIN, sourceId: 'News' });
      flexStaysInItsDaypart(plan, dayparts, 'UTC');
    });

    it('ends cooldown flex at the next daypart even when that is closer than the minimum flex', () => {
      const dayparts: Daypart[] = [{ id: 'early', label: 'Early', from: '00:00', to: '01:00', days: 'all', weights: { A: 1 } }, { id: 'late', label: 'Late', from: '01:00', to: '00:00', days: 'all', weights: { B: 1 } }];
      const plan = planSchedule([one('A', 58), one('B', 30)], settings([rule('A', { cooldownMs: 10 * HOUR }), rule('B')], { dayparts }));
      expect(plan.airings.slice(0, 3).map((airing) => [airing.sourceId, (airing.start - START) / MIN, (airing.stop - START) / MIN])).toEqual([['A', 0, 58], [null, 58, 60], ['B', 60, 90]]);
      flexStaysInItsDaypart(plan, dayparts, 'UTC');
    });

    it('keeps a daypart that crosses midnight whole', () => {
      const dayparts: Daypart[] = [{ id: 'night', label: 'Night', from: '22:00', to: '02:00', days: 'all', weights: {} }];
      const plan = planSchedule([one('Day', 45)], settings([rule('Day')], { start: START + 21 * HOUR, dayparts }));
      // 21:00 and 21:45 air (the second runs into the night: programs aren't cut); then flex until 02:00, past midnight in one piece.
      expect(plan.airings.slice(0, 3).map((airing) => [airing.sourceId, airing.start - START, airing.stop - START])).toEqual([['Day', 21 * HOUR, 21.75 * HOUR], ['Day', 21.75 * HOUR, 22.5 * HOUR], [null, 22.5 * HOUR, 26 * HOUR]]);
      flexStaysInItsDaypart(plan, dayparts, 'UTC');
    });

    it('reads boundaries in the plan’s zone, not the browser’s', () => {
      const dayparts: Daypart[] = [{ id: 'quiet', label: 'Quiet', from: '00:00', to: '08:03', days: 'all', weights: {} }];
      // 08:00 in Kolkata (UTC+05:30) is 02:30 UTC; the boundary 08:03 is 02:33 UTC.
      const from = Date.UTC(2026, 10, 2, 2, 30);
      const plan = planSchedule([one('News', 30)], settings([rule('News')], { start: from, dayparts, timeZone: 'Asia/Kolkata' }));
      expect(plan.airings[0]).toMatchObject({ start: from, stop: Date.UTC(2026, 10, 2, 2, 33), sourceId: null });
      flexStaysInItsDaypart(plan, dayparts, 'Asia/Kolkata');
    });

    it('follows the clock change: a repeated hour re-enters and leaves a daypart at the right instants', () => {
      // New York falls back at 06:00 UTC on 1 November 2026 (01:59 EDT → 01:00 EST).
      const dayparts: Daypart[] = [{ id: 'quiet', label: 'Quiet', from: '01:30', to: '03:00', days: 'all', weights: {} }];
      const from = Date.UTC(2026, 10, 1, 4); // 00:00 EDT
      const plan = planSchedule([one('Day', 30)], settings([rule('Day')], { start: from, dayparts, timeZone: 'America/New_York' }));
      const at = (hours: number, minutes = 0) => Date.UTC(2026, 10, 1, hours, minutes);
      expect(plan.airings.slice(0, 6).map((airing) => [airing.sourceId, airing.start, airing.stop])).toEqual([
        ['Day', at(4), at(4, 30)], ['Day', at(4, 30), at(5)], ['Day', at(5), at(5, 30)],
        [null, at(5, 30), at(6)], // 01:30–01:59 EDT
        ['Day', at(6), at(6, 30)], // 01:00 EST: outside the daypart again
        [null, at(6, 30), at(8)], // 01:30–03:00 EST
      ]);
      flexStaysInItsDaypart(plan, dayparts, 'America/New_York');
      // Springing forward, a boundary in the skipped hour (02:30) lands where the clock resumes (03:00 EDT, 07:00 UTC).
      const spring = planSchedule([one('Day', 30)], settings([rule('Day')], { start: Date.UTC(2026, 2, 8, 5), dayparts: [{ id: 'q', label: 'Q', from: '00:00', to: '02:30', days: 'all', weights: {} }], timeZone: 'America/New_York' }));
      expect(spring.airings[0]).toMatchObject({ sourceId: null, start: Date.UTC(2026, 2, 8, 5), stop: Date.UTC(2026, 2, 8, 7) });
    });
  });

  it('plans a month quickly', () => {
    const sources = [show('A', 10, 24, 22), show('B', 8, 20, 44), show('C', 1, 200, 95)];
    const started = performance.now();
    const plan = planSchedule(sources, settings([rule('A', { weight: 2 }), rule('B'), rule('C', { order: 'shuffle', cooldownMs: DAY })], { days: 31 }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(plan.airings.length).toBeGreaterThan(31 * 24);
  });
});

describe('saving a planned lineup', () => {
  const CHANNEL = '960f0f1e-6b20-4422-9af3-91b5705a3933';
  async function companion(schedule?: unknown) {
    const state = { lineup: [{ type: 'content', id: 'x', duration: HOUR }] as unknown[], startTime: 0, puts: 0 };
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const config = createProxyConfig({ LINEUP_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'lineup-plan-')), TUNARR_URL: 'http://tunarr:8000' });
    config.fetchImpl = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/programming')) {
        if (init.method === 'POST') state.lineup = JSON.parse(String(init.body)).lineup;
        return json({ lineup: state.lineup, programs: {}, schedule });
      }
      if (init.method === 'PUT') { state.puts += 1; state.startTime = JSON.parse(String(init.body)).startTime; }
      return json({ id: CHANNEL, number: 1, name: 'One', startTime: state.startTime });
    }) as unknown as typeof fetch;
    const save = (body: Record<string, unknown>) => handleTunarrApi({ method: 'POST', url: `/api/tunarr/channels/${CHANNEL}/programming`, headers: { host: 'lineup.local', 'content-type': 'application/json', 'if-match': `"${programmingVersion(state.lineup, schedule)}"` }, body: JSON.stringify({ type: 'manual', append: false, lineup: [{ type: 'flex', duration: HOUR }], ...body }) }, config);
    return { state, save };
  }
  const read = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

  it('sets the channel’s start time to the plan’s start, after a conditional save', async () => {
    const { state, save } = await companion();
    const response = await save({ startTime: START });
    expect(response.status).toBe(200);
    expect(read(response).startTime).toBe(START);
    expect(state.startTime).toBe(START);
    expect(state.lineup).toEqual([{ type: 'flex', duration: HOUR }]);
  });

  it('refuses a start time with keepOnAir, out of range, or on a slot-scheduled channel', async () => {
    expect((await (await companion()).save({ startTime: START, keepOnAir: true })).status).toBe(400);
    expect((await (await companion()).save({ startTime: Date.now() + 500 * DAY })).status).toBe(400);
    const scheduled = await companion({ type: 'random', slots: [] });
    const response = await scheduled.save({ startTime: START });
    expect(response.status).toBe(400);
    expect(read(response).error.message).toContain('slot schedule');
    expect(scheduled.state.puts).toBe(0);
  });
});
