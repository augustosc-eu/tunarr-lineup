// Validation and assembly of slot-schedule edits (Tunarr "time" and "random"
// schedules). The companion only lets a channel's existing schedule be
// re-arranged: every slot must draw from a source that schedule already uses,
// schedule-wide settings come from Tunarr's current copy, and the program pool
// is computed here from programs already on the channel — the same way
// Tunarr's own slot editors build it.

export type ScheduleType = 'time' | 'random';
type Json = Record<string, unknown>;

export const MAX_SLOTS = 2000;
const DAY_MS = 86_400_000;
const SLOT_TYPES = new Set(['movie', 'show', 'flex', 'redirect', 'custom-show', 'filler', 'smart-collection']);
const ORDERS = new Set(['next', 'shuffle', 'ordered_shuffle', 'alphanumeric', 'chronological']);
// Fields Tunarr adds when it "materializes" a schedule for display. They are
// not part of the schedule itself, so they are dropped before saving.
const MATERIALIZED_KEYS = ['show', 'missingShow', 'customShow', 'channel', 'fillerList', 'smartCollection', 'isMissing'];

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

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

export type ScheduleEdit = { slots: unknown; timeZoneOffset?: unknown };

/**
 * Validates edited slots against the channel's current schedule and returns
 * the schedule to send to Tunarr: the current schedule with only `slots`
 * (and, if valid, `timeZoneOffset`) replaced.
 */
export function buildEditedSchedule(current: unknown, edit: unknown): { schedule: Json } | { error: string } {
  if (!isObject(current) || (current.type !== 'time' && current.type !== 'random') || !Array.isArray(current.slots)) {
    return { error: 'This channel has no slot schedule to edit.' };
  }
  if (!isObject(edit) || !Array.isArray(edit.slots)) return { error: 'Send the edited schedule as { "slots": [...] }.' };
  const slots = edit.slots;
  if (!slots.length) return { error: 'A schedule needs at least one slot.' };
  if (slots.length > MAX_SLOTS) return { error: 'Too many slots.' };

  const allowed = new Set(current.slots.filter(isObject).map(slotSourceKey).filter((key): key is string => !!key));
  allowed.add('flex');
  const periodMs = current.type === 'time' ? (current.period === 'week' ? 7 * DAY_MS : DAY_MS) : 0;

  const cleaned: Json[] = [];
  for (const [index, raw] of slots.entries()) {
    if (!isObject(raw) || typeof raw.type !== 'string' || !SLOT_TYPES.has(raw.type)) return { error: `Slot ${index + 1} has an unsupported type.` };
    const key = slotSourceKey(raw);
    if (!key || !allowed.has(key)) return { error: `Slot ${index + 1} uses a source this channel's schedule doesn't already use.` };
    if ('order' in raw && raw.order !== undefined && (typeof raw.order !== 'string' || !ORDERS.has(raw.order))) {
      if (raw.type !== 'filler') return { error: `Slot ${index + 1} has an unknown order.` };
    }
    if (current.type === 'time') {
      if (!Number.isInteger(raw.startTime) || (raw.startTime as number) < 0 || (raw.startTime as number) >= periodMs) {
        return { error: `Slot ${index + 1} needs a start time within the ${current.period === 'week' ? 'week' : 'day'}.` };
      }
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
    if (current.type === 'random') slot.index = index;
    cleaned.push(slot);
  }

  const offset = edit.timeZoneOffset;
  const timeZoneOffset = Number.isInteger(offset) && Math.abs(offset as number) <= 14 * 60 ? offset : current.timeZoneOffset;
  return { schedule: { ...current, slots: cleaned, timeZoneOffset } };
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
 * already in the channel's lineup that some slot draws from.
 */
export function programPool(slots: Json[], lineup: unknown, programs: unknown): string[] {
  if (!Array.isArray(lineup)) return [];
  return lineup
    .filter((item): item is LineupEntry => isObject(item))
    .filter((item) => (item.type === 'content' || item.type === 'custom') && typeof item.id === 'string' && appearsInSchedule(slots, item, programs))
    .map((item) => item.id as string);
}

export function validateSeed(seed: unknown, discardCount: unknown): { seed?: number[]; discardCount?: number } | { error: string } {
  if (seed !== undefined && (!Array.isArray(seed) || seed.length > 64 || !seed.every(finite))) return { error: '"seed" must be a short array of numbers.' };
  if (discardCount !== undefined && (!Number.isInteger(discardCount) || (discardCount as number) < 0)) return { error: '"discardCount" must be a whole number.' };
  return { seed: seed as number[] | undefined, discardCount: discardCount as number | undefined };
}
