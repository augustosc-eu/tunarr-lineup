// Slot-schedule editing helpers (Tunarr "time" and "random" schedules):
// sources, settings, conversion, commercials, season filters and linked slots.
import { slotSourceKey } from '../server/slotSchedule';
import type { LineupItem, Programming } from './lineup';

export { slotSourceKey };

export type Slot = Record<string, unknown> & { type: string; id?: string };

export type SlotSchedule = {
  type: 'time' | 'random';
  slots: Slot[];
  period?: 'day' | 'week';
  padMs?: number;
  latenessMs?: number;
  maxDays?: number;
  flexPreference?: string;
  randomDistribution?: string;
  padStyle?: string;
  timeZoneOffset?: number;
  [key: string]: unknown;
};

export type SchedulePreview = {
  startTime: number;
  lineup: LineupItem[];
  programs: Programming['programs'];
  seed: number[];
  discardCount: number;
};

export type SourceOption = { key: string; label: string; template: Slot };

export const DAY_MS = 86_400_000;
/** Weekly time-slot schedules start on Sunday (day 0), as in Tunarr's own editor. */
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const ORDER_LABELS: Record<string, string> = {
  next: 'In order',
  shuffle: 'Shuffle',
  ordered_shuffle: 'Ordered shuffle',
  alphanumeric: 'Alphabetical',
  chronological: 'Chronological',
};
const LINK_FIELDS = ['iterationGroup', 'linkMode', 'rerunOverflow'];
const SOURCE_FIELDS = ['showId', 'customShowId', 'fillerListId', 'channelId', 'channelName', 'smartCollectionId', 'show', 'missingShow', 'customShow', 'fillerList', 'channel', 'smartCollection', 'isMissing', 'seasonFilter', 'seasonExcludeFilter'];
const NEEDS_ID = new Set(['movie', 'show', 'custom-show', 'smart-collection', 'filler']);

const named = (value: unknown, field: 'title' | 'name') =>
  value && typeof value === 'object' && typeof (value as Record<string, unknown>)[field] === 'string' ? (value as Record<string, string>)[field] : undefined;

/** Human name for what a slot plays, using the materialized schedule's details. */
export function slotLabel(slot: Slot): string {
  switch (slot.type) {
    case 'show': return named(slot.show, 'title') ?? named(slot.missingShow, 'title') ?? 'Show (unavailable)';
    case 'custom-show': return named(slot.customShow, 'name') ?? 'Custom show';
    case 'filler': return named(slot.fillerList, 'name') ?? 'Filler list';
    case 'redirect': return `→ ${named(slot.channel, 'name') ?? (typeof slot.channelName === 'string' ? slot.channelName : 'Another channel')}`;
    case 'smart-collection': return named(slot.smartCollection, 'name') ?? 'Smart collection';
    case 'movie': return 'Movies';
    case 'flex': return 'Flex (open airtime)';
    default: return slot.type;
  }
}

/** Every source the schedule already uses, plus flex. */
export function sourceOptions(slots: Slot[]): SourceOption[] {
  const options = new Map<string, SourceOption>();
  for (const slot of slots) {
    const key = slotSourceKey(slot);
    if (key && !options.has(key)) options.set(key, { key, label: slotLabel(slot), template: slot });
  }
  if (!options.has('flex')) options.set('flex', { key: 'flex', label: slotLabel({ type: 'flex' }), template: { type: 'flex' } });
  return [...options.values()].sort((a, b) => (a.key === 'flex' ? 1 : b.key === 'flex' ? -1 : a.label.localeCompare(b.label)));
}

/** RFC 4122 v4 id. Uses getRandomValues, which works on plain-HTTP pages. */
export function newSlotId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const withoutLinks = (slot: Slot): Slot => {
  const next = { ...slot };
  for (const field of LINK_FIELDS) delete next[field];
  return next;
};

/** A copy that plays the same source independently (its own id, unlinked). */
export function duplicateSlot(slot: Slot): Slot {
  const copy = withoutLinks(slot);
  if (NEEDS_ID.has(copy.type)) copy.id = newSlotId();
  else delete copy.id;
  return copy;
}

/**
 * Points a slot at a different existing source. Timing fields (start time,
 * weight, cooldown, length) stay; source-specific fields come from a slot that
 * already uses the new source.
 */
export function changeSlotSource(slot: Slot, option: SourceOption): Slot {
  if (slotSourceKey(slot) === option.key) return slot;
  const keep: Slot = { type: option.template.type };
  for (const field of ['startTime', 'padMs', 'overflow', 'latenessMs', 'weight', 'cooldownMs', 'periodMs', 'durationSpec', 'index']) {
    if (field in slot) keep[field] = slot[field];
  }
  const base = withoutLinks(option.template);
  for (const field of ['startTime', 'weight', 'cooldownMs', 'periodMs', 'durationSpec', 'index', 'padMs', 'overflow', 'latenessMs']) delete base[field];
  const next: Slot = { ...base, ...keep };
  if (NEEDS_ID.has(next.type)) next.id = typeof slot.id === 'string' && NEEDS_ID.has(slot.type) ? slot.id : newSlotId();
  else delete next.id;
  if (next.type === 'flex') for (const field of SOURCE_FIELDS) delete next[field];
  // Commercials belong to the slot being edited, not to the slot the new source was copied from.
  delete next.filler;
  delete next.midRoll;
  if (['movie', 'show', 'custom-show', 'smart-collection'].includes(next.type)) {
    if (slot.filler !== undefined) next.filler = slot.filler;
    if (slot.midRoll !== undefined) next.midRoll = slot.midRoll;
  }
  return next;
}

export const sortTimeSlots = (slots: Slot[]) => [...slots].sort((a, b) => Number(a.startTime) - Number(b.startTime));

export function periodMs(schedule: Pick<SlotSchedule, 'type' | 'period'>) {
  return schedule.period === 'week' ? 7 * DAY_MS : DAY_MS;
}

/** Shifts every time slot by `deltaMs`, wrapping within the period. */
export function shiftTimeSlots(slots: Slot[], deltaMs: number, period: number) {
  return sortTimeSlots(slots.map((slot) => ({ ...slot, startTime: ((((Number(slot.startTime) + deltaMs) % period) + period) % period) })));
}

export const slotWeightShare = (slots: Slot[], index: number) => {
  const total = slots.reduce((sum, slot) => sum + Math.max(0, Number(slot.weight) || 0), 0);
  return total > 0 ? (Math.max(0, Number(slots[index].weight) || 0) / total) * 100 : 0;
};

/** "HH:MM:SS" for an offset from the start of the day. */
export function offsetToClock(offsetMs: number) {
  const seconds = Math.floor((((offsetMs % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

export function clockToOffset(clock: string) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
  if (!match) return NaN;
  const [hours, minutes, seconds = '0'] = match.slice(1);
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return NaN;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Problems that would make Tunarr reject the schedule, per slot. */
export function slotProblems(schedule: Pick<SlotSchedule, 'type' | 'period'>, slots: Slot[]): Array<string | null> {
  const seen = new Map<number, number>();
  const links = linkGroups(slots);
  return slots.map((slot, index) => {
    const linkProblem = groupProblem(slots, links, slot, schedule.type);
    if (linkProblem) return linkProblem;
    if (schedule.type === 'time') {
      const start = Number(slot.startTime);
      if (!Number.isInteger(start) || start < 0 || start >= periodMs(schedule)) return 'Start time is outside the period.';
      if (seen.has(start)) return `Starts at the same time as slot ${seen.get(start)! + 1}.`;
      seen.set(start, index);
      return null;
    }
    if (!(Number(slot.weight) >= 0)) return 'Weight must be 0 or more.';
    if (!(Number(slot.cooldownMs) >= 0)) return 'Cooldown must be 0 or more.';
    const spec = slot.durationSpec as { type?: string; programCount?: number; durationMs?: number } | undefined;
    if (spec?.type === 'dynamic' && !(Number.isInteger(spec.programCount) && spec.programCount! >= 1)) return 'Plays must be at least 1 program.';
    if (spec?.type === 'fixed' && !(Number(spec.durationMs) > 0)) return 'Fixed length must be longer than 0.';
    return null;
  });
}

// ------------------------------------------------------------- full editing

/** The schedule being edited: its type, settings, slots, and extra pool programs. */
export type ScheduleDraftState = {
  type: 'time' | 'random';
  settings: Record<string, unknown>;
  slots: Slot[];
  /** Movies added to the pool movie slots draw from (not already on the channel). */
  extraMovies: Array<{ id: string; title: string }>;
};

/** Settings Lineup edits per schedule type (the companion validates the same list). */
export const SETTING_KEYS: Record<'time' | 'random', string[]> = {
  time: ['period', 'flexPreference', 'padMs', 'latenessMs', 'maxDays', 'overflow'],
  random: ['randomDistribution', 'flexPreference', 'padMs', 'padStyle', 'maxDays'],
};

export const DEFAULT_SETTINGS: Record<'time' | 'random', Record<string, unknown>> = {
  time: { period: 'day', flexPreference: 'distribute', padMs: 1, latenessMs: 0, maxDays: 365, overflow: { type: 'duration', maxMs: 0 } },
  random: { randomDistribution: 'uniform', flexPreference: 'distribute', padMs: 1, padStyle: 'slot', maxDays: 365 },
};

/** Same choices Tunarr's slot editors offer. */
export const PAD_OPTIONS: Array<[number, string]> = [[1, 'Do not pad'], [5 * 60_000, ':00, :05, :10 …'], [10 * 60_000, ':00, :10, :20 …'], [15 * 60_000, ':00, :15, :30, :45'], [30 * 60_000, ':00, :30'], [60 * 60_000, 'On the hour']];
export const LATENESS_OPTIONS: Array<[number, string]> = [[0, 'Do not allow'], [5 * 60_000, '5 minutes'], [10 * 60_000, '10 minutes'], [15 * 60_000, '15 minutes'], [30 * 60_000, '30 minutes'], [60 * 60_000, '1 hour'], [2 * 3_600_000, '2 hours'], [4 * 3_600_000, '4 hours'], [8 * 3_600_000, '8 hours']];
export const FILLER_POSITIONS: Array<[string, string]> = [['pre', 'Before each program'], ['post', 'After each program'], ['head', 'Start of slot'], ['tail', 'End of slot'], ['mid', 'Mid-roll breaks'], ['fallback', 'Fallback']];
export const FILLER_ORDER_LABELS: Record<string, string> = { shuffle_prefer_short: 'Shuffle, prefer short', shuffle_prefer_long: 'Shuffle, prefer long', uniform: 'Uniform shuffle' };

/** Starts a draft from a channel's current schedule, or a new one of `type`. */
export function draftFromSchedule(schedule: SlotSchedule | null | undefined, type: 'time' | 'random' = 'random'): ScheduleDraftState {
  const kind = schedule?.type ?? type;
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS[kind] };
  if (schedule) for (const key of SETTING_KEYS[kind]) if (schedule[key] !== undefined) settings[key] = schedule[key];
  return { type: kind, settings, slots: structuredClone(schedule?.slots ?? []), extraMovies: [] };
}

/** Converts a draft between random and time slots, keeping what each slot plays. */
export function convertDraft(draft: ScheduleDraftState, type: 'time' | 'random'): ScheduleDraftState {
  if (draft.type === type) return draft;
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS[type] };
  for (const key of ['flexPreference', 'maxDays']) if (draft.settings[key] !== undefined) settings[key] = draft.settings[key];
  if (Number(draft.settings.padMs) >= 1) settings.padMs = draft.settings.padMs;
  const count = Math.max(draft.slots.length, 1);
  const step = Math.max(60_000, Math.floor(DAY_MS / count / 60_000) * 60_000);
  const slots = draft.slots.map((slot, index) => {
    const next: Slot = { ...slot };
    if (type === 'time') {
      for (const field of ['weight', 'cooldownMs', 'durationSpec', 'index', 'periodMs']) delete next[field];
      next.startTime = (index * step) % DAY_MS;
    } else {
      for (const field of ['startTime', 'overflow', 'latenessMs']) delete next[field];
      Object.assign(next, { weight: 1, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 } });
      // Random-slot groups can't rerun, so linked slots all continue.
      if (next.linkMode === 'rerun') next.linkMode = 'continue';
    }
    return next;
  });
  return { ...draft, type, settings, slots };
}

/** Everything a slot can play: shows used so far, plus the full catalogs. */
export type SlotCatalog = {
  customShows: Array<{ id: string; name: string }>;
  fillerLists: Array<{ id: string; name: string }>;
  smartCollections: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string; number: number }>;
};

/** Source choices for a slot: existing sources first, then everything in the catalog. */
export function catalogOptions(slots: Slot[], catalog: SlotCatalog, currentChannelId?: string): SourceOption[] {
  const options = new Map<string, SourceOption>();
  const add = (option: SourceOption) => { if (!options.has(option.key)) options.set(option.key, option); };
  for (const option of sourceOptions(slots)) if (option.key !== 'flex') add(option);
  add({ key: 'movie', label: 'Movies', template: { type: 'movie', order: 'shuffle', direction: 'asc' } });
  for (const show of catalog.customShows) add({ key: `custom-show:${show.id}`, label: `Custom show: ${show.name}`, template: { type: 'custom-show', customShowId: show.id, customShow: { name: show.name }, order: 'next', direction: 'asc' } });
  for (const list of catalog.fillerLists) add({ key: `filler:${list.id}`, label: `Filler list: ${list.name}`, template: { type: 'filler', fillerListId: list.id, fillerList: { name: list.name }, order: 'shuffle_prefer_short', durationWeighting: 'linear', decayFactor: 0.5, recoveryFactor: 0.05 } });
  for (const collection of catalog.smartCollections) add({ key: `smart-collection:${collection.id}`, label: `Smart collection: ${collection.name}`, template: { type: 'smart-collection', smartCollectionId: collection.id, smartCollection: { name: collection.name }, order: 'shuffle', direction: 'asc' } });
  for (const channel of catalog.channels) {
    if (channel.id === currentChannelId) continue;
    add({ key: `redirect:${channel.id}`, label: `Redirect to CH ${channel.number} ${channel.name}`, template: { type: 'redirect', channelId: channel.id, channelName: channel.name, channel: { name: channel.name } } });
  }
  add({ key: 'flex', label: slotLabel({ type: 'flex' }), template: { type: 'flex' } });
  return [...options.values()];
}

/** The source option for a show picked from the library. */
export const showOption = (show: { id: string; title: string; mediaSourceId?: string; libraryId?: string }): SourceOption => ({
  key: `show:${show.id}`,
  label: show.title,
  template: { type: 'show', showId: show.id, show: { title: show.title, mediaSourceId: show.mediaSourceId, libraryId: show.libraryId }, order: 'next', direction: 'asc', seasonFilter: [], seasonExcludeFilter: [] },
});

/** A new slot playing `option`, timed after the existing ones. */
export function newSlot(draft: ScheduleDraftState, option: SourceOption): Slot {
  const base = changeSlotSource({ type: 'flex' }, option);
  if (draft.type === 'time') {
    const taken = new Set(draft.slots.map((slot) => Number(slot.startTime)));
    const last = draft.slots.reduce((max, slot) => Math.max(max, Number(slot.startTime) || 0), -3_600_000);
    let start = (last + 3_600_000) % periodMs({ type: 'time', period: draft.settings.period as 'day' | 'week' });
    while (taken.has(start)) start = (start + 60_000) % periodMs({ type: 'time', period: draft.settings.period as 'day' | 'week' });
    return { ...base, startTime: start };
  }
  return { ...base, weight: 1, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 } };
}

export const slotCanHaveCommercials = (slot: Slot) => ['movie', 'show', 'custom-show', 'smart-collection'].includes(slot.type);

export type SlotFiller = { types: string[]; fillerListId: string; fillerOrder?: string };
export type MidRoll = { breakRule?: { type: string; intervalMs?: number }; intervalMs?: number; maxBreaks: number; minProgramDurationMs: number; breakDurationMs?: number; strategy?: string; [key: string]: unknown };

export const DEFAULT_MID_ROLL: MidRoll = { breakRule: { type: 'fixed_interval', intervalMs: 10 * 60_000 }, maxBreaks: 3, minProgramDurationMs: 20 * 60_000, breakDurationMs: 2 * 60_000, strategy: 'eager' };

/** Short summary of a slot's commercials for its row. */
export function commercialSummary(slot: Slot, fillerNames: Map<string, string>) {
  const fillers = Array.isArray(slot.filler) ? (slot.filler as SlotFiller[]) : [];
  const parts = fillers.map((filler) => `${fillerNames.get(filler.fillerListId) ?? 'Filler'} (${filler.types.join(', ')})`);
  const mid = slot.midRoll as MidRoll | undefined;
  if (mid) parts.push(`breaks every ${Math.round((mid.breakRule?.intervalMs ?? mid.intervalMs ?? 0) / 60_000)} min`);
  return parts.join(' · ');
}

// ---------------------------------------------------------- linked slots

export const slotCanLink = (slot: Slot) => ['movie', 'show', 'custom-show', 'smart-collection'].includes(slot.type);
export const LINK_MODE_LABELS: Record<string, string> = { continue: 'Plays the next episodes', rerun: 'Reruns what the group played' };
export const RERUN_OVERFLOW_LABELS: Record<string, string> = { flex: 'Then flex time', continue: 'Then new episodes' };

export type LinkGroup = { id: string; number: number; members: number[] };

/** Groups with two or more slots, numbered in slot order. Groups of one are ignored (Tunarr unlinks them). */
export function linkGroups(slots: Slot[]): Map<string, LinkGroup> {
  const members = new Map<string, number[]>();
  slots.forEach((slot, index) => {
    if (!slotCanLink(slot) || typeof slot.iterationGroup !== 'string') return;
    members.set(slot.iterationGroup, [...(members.get(slot.iterationGroup) ?? []), index]);
  });
  const groups = new Map<string, LinkGroup>();
  let number = 0;
  for (const [id, indices] of members) if (indices.length > 1) groups.set(id, { id, number: (number += 1), members: indices });
  return groups;
}

const sameRun = (a: Slot, b: Slot) => slotSourceKey(a) === slotSourceKey(b) && a.order === b.order && (a.direction ?? 'asc') === (b.direction ?? 'asc');

function groupProblem(slots: Slot[], groups: Map<string, LinkGroup>, slot: Slot, type: 'time' | 'random'): string | null {
  const group = typeof slot.iterationGroup === 'string' ? groups.get(slot.iterationGroup) : undefined;
  if (!group) return null;
  const first = slots[group.members[0]];
  if (!group.members.every((index) => sameRun(slots[index], first))) return `Linked group ${group.number} mixes sources or play orders.`;
  const modes = new Set(group.members.map((index) => (slots[index].linkMode as string | undefined) ?? 'continue'));
  if (type === 'random' && modes.size > 1) return `Linked group ${group.number}: in random slots every member must continue, or every one rerun.`;
  if (!modes.has('continue')) return `Linked group ${group.number} needs a slot that plays new episodes.`;
  return null;
}

/** Slots that `index` could share episodes with: same source, linkable. */
export function linkCandidates(slots: Slot[], index: number) {
  const slot = slots[index];
  if (!slotCanLink(slot)) return [];
  return slots.map((other, position) => ({ other, position })).filter(({ other, position }) => position !== index && slotSourceKey(other) === slotSourceKey(slot));
}

const unlink = (slot: Slot): Slot => {
  const next = { ...slot };
  delete next.iterationGroup;
  delete next.linkMode;
  delete next.rerunOverflow;
  return next;
};

/**
 * Links slot `index` with slot `target` (joining its group, or starting a new
 * group of the two), or unlinks it when `target` is null. Joining copies the
 * group's play order and direction so the members stay compatible.
 */
export function linkSlot(slots: Slot[], index: number, target: number | null): Slot[] {
  if (target === null) return slots.map((slot, position) => (position === index ? unlink(slot) : slot));
  const anchor = slots[target];
  const group = typeof anchor.iterationGroup === 'string' ? anchor.iterationGroup : newSlotId();
  return slots.map((slot, position) => {
    if (position === target) return { ...slot, iterationGroup: group, linkMode: slot.linkMode ?? 'continue' };
    if (position === index) return { ...slot, iterationGroup: group, order: anchor.order, direction: anchor.direction ?? 'asc', linkMode: slot.linkMode ?? 'continue' };
    return slot;
  });
}

// --------------------------------------------------------- season filters

export type SeasonInfo = { number: number; title: string; episodes?: number };

/** "All seasons", "Seasons 1, 2", "All but season 3". */
export function seasonSummary(slot: Slot) {
  const only = Array.isArray(slot.seasonFilter) ? (slot.seasonFilter as number[]) : [];
  const except = Array.isArray(slot.seasonExcludeFilter) ? (slot.seasonExcludeFilter as number[]) : [];
  const list = (values: number[]) => [...values].sort((a, b) => a - b).join(', ');
  if (only.length) return `${only.length === 1 ? 'Season' : 'Seasons'} ${list(only)}`;
  if (except.length) return `All but ${except.length === 1 ? 'season' : 'seasons'} ${list(except)}`;
  return 'All seasons';
}

/** Sets which seasons a show slot plays: everything, only some, or all except some. */
export function setSeasons(slot: Slot, mode: 'all' | 'only' | 'except', seasons: number[]): Slot {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  return { ...slot, seasonFilter: mode === 'only' ? sorted : [], seasonExcludeFilter: mode === 'except' ? sorted : [] };
}
