// Validation and assembly of slot schedules (Tunarr "time" and "random"
// schedules). Lineup can create, convert and fully edit a channel's schedule:
// any source, schedule-wide settings, per-slot filler and mid-roll breaks.
// The companion checks shapes and ranges so mistakes get clear messages, and
// Tunarr's own strict validation still runs on save and preview.

export type ScheduleType = 'time' | 'random';
type Json = Record<string, unknown>;

export const MAX_SLOTS = 2000;
export const MAX_EXTRA_PROGRAMS = 5000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT_TYPES = new Set(['movie', 'show', 'flex', 'redirect', 'custom-show', 'filler', 'smart-collection']);
const LINKABLE = new Set(['movie', 'show', 'custom-show', 'smart-collection']);
const ORDERS = new Set(['next', 'shuffle', 'ordered_shuffle', 'alphanumeric', 'chronological']);
const FILLER_ORDERS = new Set(['shuffle_prefer_short', 'shuffle_prefer_long', 'uniform']);
const FILLER_TYPES = new Set(['head', 'pre', 'post', 'tail', 'fallback', 'mid']);
// Fields Tunarr adds when it "materializes" a schedule for display. They are
// not part of the schedule itself, so they are dropped before saving.
const MATERIALIZED_KEYS = ['show', 'missingShow', 'customShow', 'channel', 'fillerList', 'smartCollection', 'isMissing'];

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const wholeAtLeast = (value: unknown, min: number) => Number.isInteger(value) && (value as number) >= min;

/** Identifies what a slot plays, e.g. "show:<uuid>" or "movie". */
export function slotSourceKey(slot: Json): string | null {
  switch (slot.type) {
    case 'show': return typeof slot.showId === 'string' ? `show:${slot.showId}` : null;
    case 'custom-show': return typeof slot.customShowId === 'string' ? `custom-show:${slot.customShowId}` : null;
    case 'filler': return typeof slot.fillerListId === 'string' ? `filler:${slot.fillerListId}` : null;
    case 'redirect': return typeof slot.channelId === 'string' ? `redirect:${slot.channelId}` : null;
    case 'smart-collection': return typeof slot.smartCollectionId === 'string' ? `smart-collection:${slot.smartCollectionId}` : null;
    case 'movie': return 'movie';
    case 'flex': return 'flex';
    default: return null;
  }
}

/** Tunarr's own editor defaults for a new schedule of each type. */
export function defaultSchedule(type: ScheduleType): Json {
  return type === 'time'
    ? { type: 'time', flexPreference: 'distribute', latenessMs: 0, maxDays: 365, overflow: { type: 'duration', maxMs: 0 }, padMs: 1, period: 'day', slots: [], timeZoneOffset: 0 }
    : { type: 'random', padStyle: 'slot', randomDistribution: 'uniform', flexPreference: 'distribute', maxDays: 365, padMs: 1, slots: [], lockWeights: true, timeZoneOffset: 0 };
}

/** Settings each schedule type accepts from Lineup, with their checks. */
const SETTINGS: Record<ScheduleType, Record<string, (value: unknown) => boolean>> = {
  time: {
    flexPreference: (value) => value === 'distribute' || value === 'end',
    latenessMs: (value) => wholeAtLeast(value, 0),
    maxDays: (value) => wholeAtLeast(value, 1) && (value as number) <= 3650,
    padMs: (value) => wholeAtLeast(value, 1),
    period: (value) => value === 'day' || value === 'week',
    overflow: (value) => isObject(value) && ((value.type === 'duration' && finite(value.maxMs) && value.maxMs >= 0) || value.type === 'oneExtra'),
    startTomorrow: (value) => typeof value === 'boolean',
  },
  random: {
    flexPreference: (value) => value === 'distribute' || value === 'end',
    maxDays: (value) => wholeAtLeast(value, 1) && (value as number) <= 3650,
    padMs: (value) => wholeAtLeast(value, 0),
    padStyle: (value) => value === 'slot' || value === 'episode',
    randomDistribution: (value) => value === 'uniform' || value === 'weighted' || value === 'none',
    lockWeights: (value) => typeof value === 'boolean',
  },
};

function validateFiller(value: unknown, index: number): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 20) return `Slot ${index + 1} has invalid commercials/filler.`;
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.fillerListId !== 'string' || !UUID.test(entry.fillerListId)) return `Slot ${index + 1}: each filler needs a filler list.`;
    if (!Array.isArray(entry.types) || !entry.types.length || !entry.types.every((type) => FILLER_TYPES.has(type as string))) return `Slot ${index + 1}: choose where the filler plays (before, after, …).`;
    if (entry.fillerOrder !== undefined && !FILLER_ORDERS.has(entry.fillerOrder as string)) return `Slot ${index + 1}: unknown filler order.`;
  }
  return null;
}

function validateMidRoll(value: unknown, index: number): string | null {
  if (value === undefined) return null;
  const problem = `Slot ${index + 1}: mid-roll breaks need an interval, a break length and a maximum number of breaks.`;
  if (!isObject(value)) return problem;
  const rule = value.breakRule;
  const hasRule = isObject(rule) && (
    (rule.type === 'fixed_interval' && finite(rule.intervalMs) && rule.intervalMs > 0)
    || (rule.type === 'initial_then_interval' && finite(rule.initialDelayMs) && rule.initialDelayMs > 0 && finite(rule.intervalMs) && rule.intervalMs > 0)
    || (rule.type === 'percentage' && Array.isArray(rule.points) && rule.points.length > 0 && rule.points.every((point) => finite(point) && point > 0 && point < 100)));
  if (!hasRule && !(finite(value.intervalMs) && value.intervalMs > 0)) return problem;
  if (!wholeAtLeast(value.maxBreaks, 0) || !finite(value.minProgramDurationMs) || value.minProgramDurationMs < 0) return problem;
  const fixed = finite(value.breakDurationMs) && value.breakDurationMs > 0;
  const range = finite(value.breakDurationMinMs) && finite(value.breakDurationMaxMs) && value.breakDurationMinMs > 0 && value.breakDurationMaxMs >= value.breakDurationMinMs;
  if (!fixed && !range) return problem;
  if (value.strategy !== undefined && value.strategy !== 'eager' && value.strategy !== 'lazy') return problem;
  return null;
}

function validateSource(slot: Json, index: number): string | null {
  const label = `Slot ${index + 1}`;
  switch (slot.type) {
    case 'show': return typeof slot.showId === 'string' && slot.showId.length > 0 ? null : `${label} needs a show.`;
    case 'custom-show': return typeof slot.customShowId === 'string' && UUID.test(slot.customShowId) ? null : `${label} needs a custom show.`;
    case 'smart-collection': return typeof slot.smartCollectionId === 'string' && UUID.test(slot.smartCollectionId) ? null : `${label} needs a smart collection.`;
    case 'redirect': return typeof slot.channelId === 'string' && slot.channelId.length > 0 ? null : `${label} needs a channel to redirect to.`;
    case 'filler': {
      if (typeof slot.fillerListId !== 'string' || !UUID.test(slot.fillerListId)) return `${label} needs a filler list.`;
      if (!FILLER_ORDERS.has(slot.order as string)) return `${label} needs a filler order.`;
      if (slot.durationWeighting !== 'linear' && slot.durationWeighting !== 'log') return `${label} needs a duration weighting.`;
      if (!finite(slot.decayFactor) || slot.decayFactor < 0 || slot.decayFactor >= 1 || !finite(slot.recoveryFactor) || slot.recoveryFactor < 0 || slot.recoveryFactor >= 1) return `${label} needs decay and recovery between 0 and 1.`;
      return null;
    }
    default: return null;
  }
}

export type ScheduleEdit = { type?: unknown; settings?: unknown; slots: unknown; timeZoneOffset?: unknown };

/**
 * Builds the schedule to send to Tunarr from Lineup's edit. Starts from the
 * channel's current schedule when the type is unchanged (so fields Lineup
 * doesn't edit are kept), or from Tunarr's defaults when creating or
 * converting, then applies validated settings and slots.
 */
export function buildSchedule(current: unknown, edit: unknown): { schedule: Json } | { error: string } {
  if (!isObject(edit) || !Array.isArray(edit.slots)) return { error: 'Send the schedule as { "type", "settings", "slots" }.' };
  const currentType = isObject(current) && (current.type === 'time' || current.type === 'random') ? current.type : undefined;
  const type = edit.type ?? currentType;
  if (type !== 'time' && type !== 'random') return { error: 'Choose a random-slot or time-slot schedule.' };
  const slots = edit.slots;
  if (!slots.length) return { error: 'A schedule needs at least one slot.' };
  if (slots.length > MAX_SLOTS) return { error: 'Too many slots.' };

  const base: Json = currentType === type && isObject(current) ? { ...current } : defaultSchedule(type);
  if (edit.settings !== undefined) {
    if (!isObject(edit.settings)) return { error: '"settings" must be an object.' };
    for (const [key, value] of Object.entries(edit.settings)) {
      const check = SETTINGS[type][key];
      if (!check) return { error: `"${key.slice(0, 40)}" isn't a ${type === 'time' ? 'time-slot' : 'random-slot'} setting.` };
      if (!check(value)) return { error: `"${key}" has an invalid value.` };
      base[key] = value;
    }
  }
  const periodMs = type === 'time' ? (base.period === 'week' ? 7 * DAY_MS : DAY_MS) : 0;

  const cleaned: Json[] = [];
  const starts = new Set<number>();
  for (const [index, raw] of slots.entries()) {
    if (!isObject(raw) || typeof raw.type !== 'string' || !SLOT_TYPES.has(raw.type)) return { error: `Slot ${index + 1} has an unsupported type.` };
    const sourceProblem = validateSource(raw, index);
    if (sourceProblem) return { error: sourceProblem };
    if (LINKABLE.has(raw.type)) {
      if (typeof raw.id !== 'string' || !UUID.test(raw.id)) return { error: `Slot ${index + 1} is missing its id.` };
      if (!ORDERS.has(raw.order as string)) return { error: `Slot ${index + 1} needs a play order.` };
      if (raw.direction !== undefined && raw.direction !== 'asc' && raw.direction !== 'desc') return { error: `Slot ${index + 1} has an invalid direction.` };
    }
    const fillerProblem = validateFiller(raw.filler, index) ?? validateMidRoll(raw.midRoll, index);
    if (fillerProblem) return { error: fillerProblem };
    if (!LINKABLE.has(raw.type) && (raw.filler !== undefined || raw.midRoll !== undefined)) return { error: `Slot ${index + 1} can't have commercials of its own.` };
    if (type === 'time') {
      if (!Number.isInteger(raw.startTime) || (raw.startTime as number) < 0 || (raw.startTime as number) >= periodMs) {
        return { error: `Slot ${index + 1} needs a start time within the ${base.period === 'week' ? 'week' : 'day'}.` };
      }
      if (starts.has(raw.startTime as number)) return { error: `Slot ${index + 1} starts at the same time as another slot.` };
      starts.add(raw.startTime as number);
    } else {
      if (!finite(raw.weight) || raw.weight < 0) return { error: `Slot ${index + 1} needs a weight of 0 or more.` };
      if (!finite(raw.cooldownMs) || raw.cooldownMs < 0) return { error: `Slot ${index + 1} needs a cooldown of 0 or more.` };
      const spec = raw.durationSpec;
      if (spec !== undefined) {
        const validSpec = isObject(spec) && ((spec.type === 'fixed' && finite(spec.durationMs) && spec.durationMs > 0)
          || (spec.type === 'dynamic' && Number.isInteger(spec.programCount) && (spec.programCount as number) >= 1));
        if (!validSpec) return { error: `Slot ${index + 1} has an invalid length.` };
      }
    }
    const slot: Json = { ...raw };
    for (const field of MATERIALIZED_KEYS) delete slot[field];
    if (type === 'time') {
      for (const field of ['weight', 'cooldownMs', 'durationSpec', 'index', 'periodMs']) delete slot[field];
    } else {
      for (const field of ['startTime', 'overflow', 'latenessMs']) delete slot[field];
      if (slot.durationSpec === undefined) slot.durationSpec = { type: 'dynamic', programCount: 1 };
      slot.index = index;
    }
    cleaned.push(slot);
  }

  const offset = edit.timeZoneOffset;
  const timeZoneOffset = Number.isInteger(offset) && Math.abs(offset as number) <= 14 * 60 ? offset : base.timeZoneOffset ?? 0;
  return { schedule: { ...base, type, slots: cleaned, timeZoneOffset } };
}

type LineupEntry = { type?: unknown; id?: unknown; customShowId?: unknown; fillerListId?: unknown };

function programOf(programs: unknown, id: unknown): Json | undefined {
  if (!isObject(programs) || typeof id !== 'string') return undefined;
  const entry = programs[id];
  if (!isObject(entry)) return undefined;
  return isObject(entry.program) ? entry.program : entry;
}

function showOf(program: Json | undefined) {
  if (!program || program.type !== 'episode') return undefined;
  const show = isObject(program.show) ? program.show : isObject(program.season) && isObject(program.season.show) ? program.season.show : undefined;
  return show ? (show.uuid ?? show.title) : undefined;
}

/** Port of Tunarr's `lineupItemAppearsInSchedule` (web/src/helpers/slotSchedulerUtil.ts). */
function appearsInSchedule(slots: Json[], item: LineupEntry, programs: unknown) {
  return slots.some((slot) => {
    switch (slot.type) {
      case 'custom-show': return item.type === 'custom' && item.customShowId === slot.customShowId;
      case 'filler': return item.type === 'filler' && item.fillerListId === slot.fillerListId;
      case 'redirect': return item.type === 'redirect';
      case 'flex': return item.type === 'flex';
      case 'movie': return (item.type === 'content' || item.type === 'custom') && programOf(programs, item.id)?.type === 'movie';
      case 'smart-collection': return true;
      case 'show': return item.type === 'content' && showOf(programOf(programs, item.id)) === slot.showId;
      default: return false;
    }
  });
}

/**
 * The program ids Tunarr should schedule from: content and custom-show items
 * already in the channel's lineup that some slot draws from (as Tunarr's own
 * editors build it), plus any programs Lineup was asked to add to the pool
 * (for example movies for a movie slot). Shows, custom shows, filler lists
 * and smart collections referenced by slots are expanded by Tunarr itself.
 */
export function programPool(slots: Json[], lineup: unknown, programs: unknown, extra: string[] = []): string[] {
  const fromLineup = Array.isArray(lineup)
    ? lineup
      .filter((item): item is LineupEntry => isObject(item))
      .filter((item) => (item.type === 'content' || item.type === 'custom') && typeof item.id === 'string' && appearsInSchedule(slots, item, programs))
      .map((item) => item.id as string)
    : [];
  const pool = [...fromLineup];
  const seen = new Set(fromLineup);
  for (const id of extra) {
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push(id);
  }
  return pool;
}

export function validateExtraPrograms(value: unknown): { ids: string[] } | { error: string } {
  if (value === undefined) return { ids: [] };
  if (!Array.isArray(value) || value.length > MAX_EXTRA_PROGRAMS || !value.every((id) => typeof id === 'string' && UUID.test(id))) {
    return { error: '"extraPrograms" must be a list of program ids.' };
  }
  return { ids: value as string[] };
}

export function validateSeed(seed: unknown, discardCount: unknown): { seed?: number[]; discardCount?: number } | { error: string } {
  if (seed !== undefined && (!Array.isArray(seed) || seed.length > 64 || !seed.every(finite))) return { error: '"seed" must be a short array of numbers.' };
  if (discardCount !== undefined && (!Number.isInteger(discardCount) || (discardCount as number) < 0)) return { error: '"discardCount" must be a whole number.' };
  return { seed: seed as number[] | undefined, discardCount: discardCount as number | undefined };
}
