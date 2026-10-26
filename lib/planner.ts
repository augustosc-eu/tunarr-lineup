// The advanced planner (roadmap milestone 5, D67): rotations between shows and
// collections, worked out ahead of time into a fixed lineup that the desk
// previews and saves like any other. Pure and deterministic: the same sources,
// rules and seed always give the same plan, so what was previewed is exactly
// what's saved. It never reads a media server and never runs by itself; a plan
// is a snapshot of the library as it was, which the dialog says.
//
// Fairness is virtual time (start-time fair queueing): each source carries a
// clock that advances by what it airs divided by its weight (minutes when
// balancing airtime, one unit per program when balancing counts), and the
// source with the earliest clock goes next. Over any stretch the shares come
// out as the weights say, give or take one program, which is what the summary
// explains. The seed only breaks ties and shuffles.
import { offsetAt, wallClock, zonedInstants } from '../server/calendar';

export type PlannerProgram = { id: string; duration: number; title: string; season?: number; episode?: number; genres: string[]; type: string };
export type PlannerSource = { id: string; label: string; programs: PlannerProgram[] };

/**
 * episode: in season and episode order from `start` (the first episode by
 * default), wrapping round; season-block: the same, but once a source starts a
 * season it keeps the air until that season ends; shuffle: a seeded shuffle,
 * reshuffled every pass.
 */
export type PlayOrder = 'episode' | 'season-block' | 'shuffle';

export type SourceRule = {
  sourceId: string;
  weight: number;
  order: PlayOrder;
  start: { season: number; episode: number } | null;
  /** How many times one program may air in the plan; null: no limit. */
  maxRepeats: number | null;
  /** The least time between two airings of the same program. */
  cooldownMs: number;
};

/** A part of the day with its own weights (a weight of 0 keeps a source out of it). */
export type Daypart = { id: string; label: string; from: string; to: string; days: 'all' | 'weekdays' | 'weekend'; weights: Record<string, number> };

export type PlannerSettings = {
  seed: string;
  start: number;
  days: number;
  /** What the weights share out: airtime, or the number of programs. */
  balance: 'duration' | 'count';
  rules: SourceRule[];
  dayparts: Daypart[];
  /** The zone dayparts and weekdays are read in. */
  timeZone: string;
};

export type PlannedAiring = { start: number; stop: number; sourceId: string | null; programId: string | null; title: string };
export type PlanItem = { type: 'content'; id: string; duration: number } | { type: 'flex'; duration: number };
export type SourceShare = { sourceId: string; label: string; count: number; duration: number; share: number; target: number };
export type Plan = {
  seed: string;
  start: number;
  /** Where the plan really ends: the end asked for, or where it stopped when `truncated`. */
  end: number;
  /**
   * Set when the plan hit MAX_PLAN_AIRINGS before covering what was asked:
   * it then covers `start` to `reachedAt` only, and can't be saved.
   */
  truncated: { requestedEnd: number; reachedAt: number; limit: number } | null;
  airings: PlannedAiring[];
  items: PlanItem[];
  summary: { sources: SourceShare[]; genres: Array<{ name: string; duration: number }>; types: Array<{ name: string; duration: number }>; flex: number };
  warnings: string[];
};

export const MAX_PLAN_DAYS = 31;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * The least flex added while programs cool down, so the plan doesn't fill with
 * slivers. A daypart boundary closer than this still ends the flex there.
 */
export const MIN_FLEX_MS = 5 * 60_000;
/** A defensive limit on the airings in one plan (very short programs over a month). */
export const MAX_PLAN_AIRINGS = 50_000;

// ------------------------------------------------------------------- seeds

/** A 32-bit hash of the seed text. */
function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** mulberry32: a small, good-enough PRNG; deterministic for a seed. */
export function seededRandom(seed: string) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [out[index], out[pick]] = [out[pick], out[index]];
  }
  return out;
}

/** A fresh seed for the dialog's "New seed": short and readable. */
export const newSeed = (random = Math.random) => Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');

// ----------------------------------------------------------------- ordering

/** Numbers first, in order; missing numbers last. */
const byNumber = (a?: number, b?: number) => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b);

/** Season then episode, unnumbered last, otherwise in their given order. */
export function episodeOrder(programs: PlannerProgram[]): PlannerProgram[] {
  return programs.map((program, index) => ({ program, index }))
    .sort((a, b) => byNumber(a.program.season, b.program.season) || byNumber(a.program.episode, b.program.episode) || a.index - b.index)
    .map((entry) => entry.program);
}

/** Where to begin: the chosen season and episode (or the next one after it), else the first. */
function startIndex(programs: PlannerProgram[], start: SourceRule['start']) {
  if (!start) return 0;
  const at = programs.findIndex((program) => (program.season ?? 0) > start.season || ((program.season ?? 0) === start.season && (program.episode ?? 0) >= start.episode));
  return at < 0 ? 0 : at;
}

// ---------------------------------------------------------------- dayparts

const when = (ms: number, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const minutesOf = (time: string) => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute; };

/** The daypart in force at `at`, if any (the first listed wins). */
export function daypartAt(dayparts: Daypart[], at: number, timeZone: string): Daypart | null {
  if (!dayparts.length) return null;
  const clock = wallClock(at, timeZone);
  const minute = clock.hour * 60 + clock.minute;
  const weekend = clock.weekday === 0 || clock.weekday === 6;
  for (const part of dayparts) {
    if (part.days === 'weekdays' && weekend) continue;
    if (part.days === 'weekend' && !weekend) continue;
    const from = minutesOf(part.from);
    const to = minutesOf(part.to);
    const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
    if (inside) return part;
  }
  return null;
}

/**
 * Every instant from `from` to `to` at which the daypart in force can change,
 * sorted: each daypart's start and end and each local midnight (the weekday
 * rules) on every local date, both instants of a time the clocks repeat, and
 * the clock changes themselves (a repeated hour can re-enter a daypart). A
 * daypart only changes at one of these, so the next change is found exactly,
 * to the minute, in the chosen zone.
 */
export function daypartBoundaries(dayparts: Daypart[], from: number, to: number, timeZone: string): number[] {
  if (!dayparts.length) return [];
  const times = [...new Set(['00:00', ...dayparts.flatMap((part) => [part.from, part.to])])].map(minutesOf);
  const out = new Set<number>();
  const first = wallClock(from - DAY, timeZone);
  for (let index = 0; ; index += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + index));
    if (date.getTime() > to + 2 * DAY) break;
    for (const minute of times) for (const at of zonedInstants(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(minute / 60), minute % 60, timeZone)) out.add(at);
  }
  // Clock changes: where the offset differs an hour apart, narrowed to the minute it changes.
  for (let at = from - DAY; at < to + DAY; at += HOUR) {
    if (offsetAt(at, timeZone) === offsetAt(at + HOUR, timeZone)) continue;
    let low = Math.floor(at / 60_000);
    let high = Math.ceil((at + HOUR) / 60_000);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (offsetAt(middle * 60_000, timeZone) === offsetAt(at, timeZone)) low = middle;
      else high = middle;
    }
    out.add(high * 60_000);
  }
  return [...out].filter((at) => at > from - DAY && at < to + DAY).sort((a, b) => a - b);
}

/** The first boundary after `at` where the daypart in force really changes, or `limit`. */
export function nextDaypartChange(dayparts: Daypart[], boundaries: number[], at: number, timeZone: string, limit: number) {
  const now = daypartAt(dayparts, at, timeZone)?.id ?? null;
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (boundaries[middle] <= at) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < boundaries.length && boundaries[index] < limit; index += 1) {
    if ((daypartAt(dayparts, boundaries[index], timeZone)?.id ?? null) !== now) return boundaries[index];
  }
  return limit;
}

// --------------------------------------------------------------------- plan

type Next = { index: number; program: PlannerProgram };

type Lane = {
  rule: SourceRule;
  source: PlannerSource;
  sequence: PlannerProgram[];
  cursor: number;
  clock: number;
  aired: Map<string, number>;
  lastStop: Map<string, number>;
  exhaustedAt: number | null;
};

/** The plan: airings from `start` until the end of the last day (the last program may run past it: Tunarr can't cut one short). */
export function planSchedule(sources: PlannerSource[], settings: PlannerSettings): Plan {
  const random = seededRandom(settings.seed);
  const start = settings.start;
  const days = Math.max(1, Math.min(MAX_PLAN_DAYS, Math.round(settings.days)));
  const end = start + days * DAY;
  const warnings: string[] = [];
  const unit = (duration: number) => (settings.balance === 'duration' ? duration : HOUR);

  const lanes: Lane[] = [];
  for (const rule of settings.rules) {
    const source = sources.find((item) => item.id === rule.sourceId);
    const programs = (source?.programs ?? []).filter((program) => program.duration > 0);
    if (!source) continue;
    if (!programs.length) { warnings.push(`“${source.label}” has no programs with a length, so it never airs.`); continue; }
    if (!(rule.weight > 0) && !settings.dayparts.some((part) => (part.weights[rule.sourceId] ?? 0) > 0)) { warnings.push(`“${source.label}” has a weight of 0 everywhere, so it never airs.`); continue; }
    const ordered = episodeOrder(programs);
    const sequence = rule.order === 'shuffle' ? shuffle(ordered, random) : ordered;
    lanes.push({ rule, source, sequence, cursor: rule.order === 'shuffle' ? 0 : startIndex(sequence, rule.start), clock: 0, aired: new Map(), lastStop: new Map(), exhaustedAt: null });
  }
  // Ties go to a seeded order, so two equal sources don't always start the same way.
  const tieOrder = new Map(shuffle(lanes.map((lane) => lane.rule.sourceId), random).map((id, index) => [id, index]));

  const weightOf = (lane: Lane, at: number) => {
    const part = daypartAt(settings.dayparts, at, settings.timeZone);
    return part ? (part.weights[lane.rule.sourceId] ?? 0) : lane.rule.weight;
  };

  /** The next program `lane` may air at `at`, without moving its cursor. */
  const nextFor = (lane: Lane, at: number): Next | null => {
    const { sequence, rule } = lane;
    for (let step = 0; step < sequence.length; step += 1) {
      const index = (lane.cursor + step) % sequence.length;
      const program = sequence[index];
      if (rule.maxRepeats !== null && (lane.aired.get(program.id) ?? 0) >= rule.maxRepeats) continue;
      const last = lane.lastStop.get(program.id);
      if (last !== undefined && at - last < rule.cooldownMs) continue;
      return { index, program };
    }
    return null;
  };
  const used = (lane: Lane) => lane.sequence.every((program) => lane.rule.maxRepeats !== null && (lane.aired.get(program.id) ?? 0) >= lane.rule.maxRepeats);

  const boundaries = daypartBoundaries(settings.dayparts, start, end, settings.timeZone);
  const airings: PlannedAiring[] = [];
  let at = start;
  let virtual = 0;
  let sticky: Lane | null = null;
  let flexTotal = 0;
  const noSourceParts = new Set<string>();
  while (at < end && airings.length < MAX_PLAN_AIRINGS) {
    const eligible = lanes.filter((lane) => lane.exhaustedAt === null && weightOf(lane, at) > 0);
    // A source joining (a daypart opening) starts level with the others rather than with a backlog.
    for (const lane of eligible) lane.clock = Math.max(lane.clock, virtual);
    const ranked: Lane[] = sticky && eligible.includes(sticky) ? [sticky] : [...eligible].sort((a, b) => a.clock - b.clock || tieOrder.get(a.rule.sourceId)! - tieOrder.get(b.rule.sourceId)!);
    let chosen: { lane: Lane; next: Next } | null = null;
    for (const lane of ranked) {
      const next = nextFor(lane, at);
      if (next) { chosen = { lane, next }; break; }
    }
    if (!chosen && sticky) {
      sticky = null;
      continue;
    }
    if (!chosen) {
      // Nothing may air now: a daypart with no source, or every program cooling down.
      const part = daypartAt(settings.dayparts, at, settings.timeZone);
      if (!eligible.length && part) noSourceParts.add(part.label);
      const cooling = eligible.flatMap((lane) => [...lane.lastStop.values()].map((stop) => stop + lane.rule.cooldownMs)).filter((time) => time > at);
      // Flex never runs into the next daypart (or more than a day, or past the end), even when that leaves less than MIN_FLEX_MS.
      const boundary = nextDaypartChange(settings.dayparts, boundaries, at, settings.timeZone, Math.min(end, at + DAY));
      const cooled = eligible.length && cooling.length ? Math.min(...cooling) : Infinity;
      const gap = cooled < boundary ? Math.min(boundary - at, Math.max(MIN_FLEX_MS, cooled - at)) : boundary - at;
      airings.push({ start: at, stop: at + gap, sourceId: null, programId: null, title: 'Flex time' });
      flexTotal += gap;
      at += gap;
      continue;
    }
    const { lane, next } = chosen;
    const stop = at + next.program.duration;
    airings.push({ start: at, stop, sourceId: lane.rule.sourceId, programId: next.program.id, title: next.program.title });
    lane.aired.set(next.program.id, (lane.aired.get(next.program.id) ?? 0) + 1);
    lane.lastStop.set(next.program.id, stop);
    lane.cursor = (next.index + 1) % lane.sequence.length;
    if (lane.cursor === 0 && lane.rule.order === 'shuffle') lane.sequence = shuffle(lane.sequence, random);
    virtual = lane.clock;
    lane.clock += unit(next.program.duration) / Math.max(weightOf(lane, at), Number.EPSILON);
    if (lane.rule.maxRepeats !== null && used(lane)) lane.exhaustedAt = stop;
    // A season block keeps the air until its season ends.
    const following = lane.sequence[lane.cursor];
    sticky = lane.rule.order === 'season-block' && following && following.season === next.program.season && lane.cursor !== 0 ? lane : null;
    at = stop;
  }

  // ---- What it adds up to.
  const total = airings.reduce((sum, airing) => sum + (airing.sourceId ? airing.stop - airing.start : 0), 0);
  const programsCount = airings.filter((airing) => airing.sourceId).length;
  const baseWeights = lanes.reduce((sum, lane) => sum + Math.max(0, lane.rule.weight), 0);
  const shares: SourceShare[] = lanes.map((lane) => {
    const mine = airings.filter((airing) => airing.sourceId === lane.rule.sourceId);
    const duration = mine.reduce((sum, airing) => sum + airing.stop - airing.start, 0);
    return {
      sourceId: lane.rule.sourceId, label: lane.source.label, count: mine.length, duration,
      share: settings.balance === 'duration' ? (total ? duration / total : 0) : (programsCount ? mine.length / programsCount : 0),
      target: baseWeights ? Math.max(0, lane.rule.weight) / baseWeights : 0,
    };
  });
  const byProgram = new Map(lanes.flatMap((lane) => lane.sequence.map((program) => [program.id, program] as const)));
  const tally = (key: (program: PlannerProgram) => string[]) => {
    const sums = new Map<string, number>();
    for (const airing of airings) {
      const program = airing.programId ? byProgram.get(airing.programId) : undefined;
      if (!program) continue;
      const names = key(program);
      for (const name of names.length ? names : ['Unknown']) sums.set(name, (sums.get(name) ?? 0) + (airing.stop - airing.start) / Math.max(1, names.length));
    }
    return [...sums].map(([name, duration]) => ({ name, duration })).sort((a, b) => b.duration - a.duration);
  };

  for (const lane of lanes) {
    if (lane.exhaustedAt !== null) warnings.push(`“${lane.source.label}” ran out at ${when(lane.exhaustedAt, settings.timeZone)}: every program reached its repeat limit (${lane.rule.maxRepeats}). Raise the limit, add programs, or plan fewer days.`);
    else {
      const count = airings.filter((airing) => airing.sourceId === lane.rule.sourceId).length;
      if (count > lane.sequence.length) warnings.push(`“${lane.source.label}” went round ${Math.ceil(count / lane.sequence.length)} times: it has ${lane.sequence.length} programs for its share of ${days} day${days === 1 ? '' : 's'}.`);
    }
  }
  for (const label of noSourceParts) warnings.push(`No source has a weight in “${label}”, so it fills with flex time.`);
  if (flexTotal > 0) warnings.push(`${Math.round(flexTotal / 60_000)} minutes of flex time were needed (cooldowns or a daypart without sources).`);
  for (const share of shares) {
    if (share.target > 0 && settings.dayparts.length === 0 && programsCount > lanes.length * 4 && Math.abs(share.share - share.target) > 0.15) {
      warnings.push(`“${share.label}” got ${Math.round(share.share * 100)}% instead of ${Math.round(share.target * 100)}%: its repeat limit or cooldown held it back.`);
    }
  }

  // Stopped by the limit, not by the end: say so first, and never report the end that wasn't reached.
  const truncated = at < end ? { requestedEnd: end, reachedAt: at, limit: MAX_PLAN_AIRINGS } : null;
  if (truncated) warnings.unshift(planTruncatedReason(truncated, settings.timeZone));

  const items: PlanItem[] = airings.map((airing) => (airing.programId ? { type: 'content', id: airing.programId, duration: airing.stop - airing.start } : { type: 'flex', duration: airing.stop - airing.start }));
  return { seed: settings.seed, start, end: truncated ? at : end, truncated, airings, items, summary: { sources: shares, genres: tally((program) => program.genres), types: tally((program) => [program.type]), flex: flexTotal }, warnings };
}

/** Why a truncated plan can't be saved, in the dialog's words. */
export function planTruncatedReason(truncated: NonNullable<Plan['truncated']>, timeZone: string) {
  return `Incomplete: the plan reached its limit of ${truncated.limit.toLocaleString('en')} programs at ${when(truncated.reachedAt, timeZone)}, before ${when(truncated.requestedEnd, timeZone)}. It can’t be saved: plan fewer days, or use longer programs.`;
}

/** Why a previewed plan can't be saved as it is, or null when it can. */
export const planSaveBlocked = (plan: Plan, timeZone: string): string | null => (plan.truncated ? planTruncatedReason(plan.truncated, timeZone) : null);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const names = (value: unknown) => (Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? [item] : isObject(item) && typeof item.name === 'string' ? [item.name] : [])) : []);

/**
 * A library program (Tunarr's content entry, as descendants and search return
 * it) as the planner sees it: its season and episode numbers, and its genres
 * (the program's, else the show's it came with).
 */
export function plannerProgram(entry: { id: string; duration: number; program: Record<string, unknown> }, showGenres: string[] = []): PlannerProgram {
  const program = entry.program;
  const season = typeof program.seasonNumber === 'number' ? program.seasonNumber : isObject(program.season) && typeof program.season.index === 'number' ? program.season.index : undefined;
  const episode = typeof program.episodeNumber === 'number' ? program.episodeNumber : typeof program.index === 'number' && program.type === 'episode' ? program.index : undefined;
  const genres = names(program.genres);
  return {
    id: entry.id, duration: entry.duration, title: typeof program.title === 'string' ? program.title : 'Untitled',
    ...(season !== undefined ? { season } : {}), ...(episode !== undefined ? { episode } : {}),
    genres: genres.length ? genres : showGenres, type: typeof program.type === 'string' ? program.type : 'program',
  };
}
