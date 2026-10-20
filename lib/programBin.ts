// The program bin: picked library programs, arranged into lineup items with
// the options chosen for them (order, repeats, what airs after each one).
import { makeBreakWithId, makeCommercialBreak, makeFlex } from './broadcast';
import { exactBoundary, passesBefore, type InsertWhere } from './events';
import type { ContentProgram } from './library';
import type { LineupItem } from './lineup';

/** Where placed programs go: the Insert dialog's places, the end of the lineup, or a lineup position (a drop on a row, near that row's airing). */
export type PlaceWhere = InsertWhere | 'end' | { index: number; near: number };

export type BinOrder = 'picked' | 'episode' | 'shuffle' | 'mix';

export const BIN_ORDER_LABELS: Record<BinOrder, string> = {
  picked: 'As picked',
  episode: 'Episode order',
  shuffle: 'Shuffle',
  mix: 'Shuffle shows, episodes in order',
};

/** What airs after each program: nothing, open airtime, or a commercial break (optionally opened by a station ID). */
export type BinAfter =
  | { kind: 'none' }
  | { kind: 'flex'; duration: number }
  | { kind: 'break'; duration: number; fillerListIds: string[]; stationIds?: Array<{ id: string; duration: number }> };

export type BinOptions = { order: BinOrder; repeat: number; after: BinAfter };

export const DEFAULT_BIN_OPTIONS: BinOptions = { order: 'picked', repeat: 1, after: { kind: 'none' } };
export const MAX_BIN_REPEAT = 20;

/** `units`: each program with what airs after it, the pieces time slots are filled with. */
export type Arranged = { items: LineupItem[]; meta: Record<string, ContentProgram>; programs: ContentProgram[]; units: LineupItem[][] };

type Meta = { type?: string; title?: string; seasonNumber?: number; episodeNumber?: number; index?: number; season?: { index?: number }; show?: { uuid?: string; title?: string }; showTitle?: string; grandparent?: { uuid?: string } };
const metaOf = (program: ContentProgram) => (program.program ?? {}) as Meta;
const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The show an episode belongs to, so episode order keeps each show together. */
const showKey = (program: ContentProgram) => {
  const meta = metaOf(program);
  return meta.show?.uuid ?? meta.grandparent?.uuid ?? meta.show?.title ?? meta.showTitle ?? '';
};

/**
 * Season, then episode, within each show; shows (and programs that aren't
 * episodes) keep the order they were first picked in.
 */
export function episodeOrder(programs: ContentProgram[]) {
  const firstSeen = new Map<string, number>();
  programs.forEach((program, at) => {
    const key = showKey(program) || `#${at}`;
    if (!firstSeen.has(key)) firstSeen.set(key, at);
  });
  const rank = (program: ContentProgram, at: number) => {
    const meta = metaOf(program);
    return {
      group: firstSeen.get(showKey(program) || `#${at}`) ?? at,
      season: numberOr(meta.season?.index ?? meta.seasonNumber, Infinity),
      episode: numberOr(meta.episodeNumber ?? (meta.type === 'episode' ? meta.index : undefined), Infinity),
      at,
    };
  };
  return programs
    .map((program, at) => ({ program, key: rank(program, at) }))
    .sort((a, b) => a.key.group - b.key.group || a.key.season - b.key.season || a.key.episode - b.key.episode || a.key.at - b.key.at)
    .map((entry) => entry.program);
}

export function shuffled<T>(items: T[], random: () => number = Math.random) {
  const next = [...items];
  for (let at = next.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [next[at], next[other]] = [next[other], next[at]];
  }
  return next;
}

/**
 * Shows (and other programs) mixed at random, while each show's episodes keep
 * their season and episode order. Each next program comes from a show drawn
 * in proportion to the episodes it has left, so shows spread out evenly
 * instead of one finishing long before the others.
 */
export function mixedInOrder(programs: ContentProgram[], random: () => number = Math.random) {
  const queues = new Map<string, ContentProgram[]>();
  episodeOrder(programs).forEach((program, at) => {
    const key = showKey(program) || `#${at}`;
    queues.set(key, [...(queues.get(key) ?? []), program]);
  });
  const lines = [...queues.values()];
  const mixed: ContentProgram[] = [];
  let left = programs.length;
  while (left > 0) {
    let draw = Math.floor(random() * left);
    const line = lines.find((queue) => (draw -= queue.length) < 0) ?? lines.find((queue) => queue.length)!;
    mixed.push(line.shift()!);
    left -= 1;
  }
  return mixed;
}

/**
 * Lineup items for the picked programs. Zero-length programs are left out.
 * Each repeat is a new pass in the chosen order (a shuffle is reshuffled), and
 * station IDs rotate from one break to the next.
 */
export function arrangePrograms(picked: ContentProgram[], options: BinOptions, random: () => number = Math.random): Arranged {
  const playable = picked.filter((program) => program.duration > 0);
  const repeat = Math.min(MAX_BIN_REPEAT, Math.max(1, Math.round(options.repeat) || 1));
  const programs: ContentProgram[] = [];
  for (let pass = 0; pass < repeat; pass += 1) {
    programs.push(...(options.order === 'episode' ? episodeOrder(playable) : options.order === 'shuffle' ? shuffled(playable, random) : options.order === 'mix' ? mixedInOrder(playable, random) : playable));
  }
  const units: LineupItem[][] = [];
  const meta: Record<string, ContentProgram> = {};
  const after = options.after;
  const ids = after.kind === 'break' ? (after.stationIds ?? []).filter((id) => id.duration > 0 && id.duration < after.duration) : [];
  let nextId = 0;
  for (const program of programs) {
    const unit: LineupItem[] = [{ type: 'content', id: program.id, duration: program.duration }];
    meta[program.id] = program;
    if (after.kind === 'flex' && after.duration >= 1000) unit.push(makeFlex(after.duration));
    if (after.kind === 'break' && after.duration >= 1000 && after.fillerListIds.length) {
      const id = ids.length ? ids[nextId++ % ids.length] : undefined;
      unit.push(...(id ? makeBreakWithId(after.duration, after.fillerListIds, id) : [makeCommercialBreak(after.duration, after.fillerListIds)]));
    }
    units.push(unit);
  }
  return { items: units.flat(), meta, programs, units };
}

export const arrangedDuration = (arranged: Pick<Arranged, 'items'>) => arranged.items.reduce((sum, item) => sum + (item.duration > 0 ? item.duration : 0), 0);

/** “A”, “A” and “B”, or “A”, “B” and 3 more: what was placed, for the edit list. */
export function placedLabel(programs: ContentProgram[]) {
  const titles = [...new Set(programs.map((program) => `“${String(metaOf(program).title ?? 'program')}”`))];
  const repeats = programs.length > titles.length ? ` (${programs.length.toLocaleString('en')} airings)` : '';
  if (titles.length <= 2) return titles.join(' and ') + repeats;
  if (titles.length === 3) return `${titles[0]}, ${titles[1]} and ${titles[2]}${repeats}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more${repeats}`;
}

/** Weekdays as `Date#getDay()` numbers, Monday first (how the bin lists them). */
export const WEEKDAYS: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/**
 * A recurring time slot: from a first day (yyyy-mm-dd) at a time (HH:MM), on
 * the chosen weekdays. Each slot airs `count` programs, or as many as fit
 * before `until` (HH:MM; at least one, so the plan keeps moving).
 */
export type SlotPlan = { day: string; time: string; weekdays: number[]; fill: { kind: 'count'; count: number } | { kind: 'until'; until: string } };

export type PlacedSlot = { at: number; index: number; count: number; programs: number; gap: number };

export type SlotPlacement = {
  lineup: LineupItem[];
  slots: PlacedSlot[];
  /** Programs placed, and programs left over. */
  placed: number;
  left: number;
  /** Open airtime added in front of slots so each starts on time (ms). */
  gaps: number;
  /**
   * Why it stopped before placing everything: the lineup repeats before the
   * next slot (`at`), or each slot would move the ones before it (the lineup
   * has repeated since the point kept in place).
   */
  stopped?: { reason: 'repeats' | 'moves'; at: number };
};

export const MAX_SLOTS = 1000;
const DAY = 86_400_000;

/** Slot length in ms when filling until a time: up to the next `until` after the start (past midnight if need be). */
export function slotWindow(time: string, until: string) {
  const minutes = (value: string) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const length = (minutes(until) - minutes(time)) * 60_000;
  return length > 0 ? length : length + DAY;
}

/** The slot start times, in order: local clock time, so a DST change doesn't move them. */
export function slotTimes(plan: Pick<SlotPlan, 'day' | 'time' | 'weekdays'>, limit = MAX_SLOTS) {
  const [year, month, date] = plan.day.split('-').map(Number);
  const [hours, minutes] = plan.time.split(':').map(Number);
  const times: number[] = [];
  if (![year, month, date, hours, minutes].every(Number.isFinite) || !plan.weekdays.length) return times;
  for (let offset = 0; times.length < limit && offset < limit * 7; offset += 1) {
    const at = new Date(year, month - 1, date + offset, hours, minutes);
    if (plan.weekdays.includes(at.getDay())) times.push(at.getTime());
  }
  return times;
}

/** When lineup[index] airs on the pass around `near`. */
function occurrence(lineup: LineupItem[], start: number, index: number, near: number) {
  const length = lineup.reduce((sum, item) => sum + item.duration, 0);
  const pass = Math.floor((near - start) / length);
  return start + pass * length + lineup.slice(0, index).reduce((sum, item) => sum + item.duration, 0);
}

/**
 * Puts the units into recurring slots, one slot after another, each starting
 * exactly on time: the program airing then (and everything after it) moves
 * later, with open airtime filling up to the slot. A manual lineup repeats, so
 * slots only keep their time within one pass of it: placing stops when the
 * next slot falls in another pass, or when a slot would move the first one.
 * `startWith(ms)`: the channel start once the lineup is `ms` longer.
 */
export function placeInSlots(lineup: LineupItem[], startWith: (added: number) => number, units: LineupItem[][], plan: SlotPlan): SlotPlacement | null {
  if (!lineup.length || !units.length) return null;
  const window = plan.fill.kind === 'until' ? slotWindow(plan.time, plan.fill.until) : 0;
  const perSlot = plan.fill.kind === 'count' ? Math.max(1, Math.round(plan.fill.count)) : Infinity;
  let current = lineup;
  let added = 0;
  let next = 0;
  let gaps = 0;
  const slots: PlacedSlot[] = [];
  let stopped: SlotPlacement['stopped'];
  for (const at of slotTimes(plan)) {
    if (next >= units.length) break;
    const first = slots[0];
    if (first && passesBefore(current, startWith(added), at) !== passesBefore(current, startWith(added), first.at)) { stopped = { reason: 'repeats', at }; break; }
    const taken: LineupItem[][] = [];
    let length = 0;
    while (next + taken.length < units.length && taken.length < perSlot) {
      const unit = units[next + taken.length];
      const unitLength = unit.reduce((sum, item) => sum + item.duration, 0);
      if (window && taken.length && length + unitLength > window) break;
      taken.push(unit);
      length += unitLength;
    }
    const boundary = exactBoundary(current, (more) => startWith(added + more), at, length);
    if (!boundary) { stopped = { reason: 'moves', at }; break; }
    // A slot that would start inside the last one's programs is skipped: they run past it.
    const last = slots[slots.length - 1];
    if (last && boundary.index < last.index + last.count) continue;
    const items = [...(boundary.gap ? [makeFlex(boundary.gap)] : []), ...taken.flat()];
    const after = [...current.slice(0, boundary.index), ...items, ...current.slice(boundary.index)];
    const afterAdded = added + length + boundary.gap;
    // Later slots sit later in the same pass, so if the first one held, they all did.
    if (first && Math.abs(occurrence(after, startWith(afterAdded), first.index, first.at) + first.gap - first.at) >= 1000) { stopped = { reason: 'moves', at }; break; }
    slots.push({ at, index: boundary.index, count: items.length, programs: taken.length, gap: boundary.gap });
    current = after;
    added = afterAdded;
    gaps += boundary.gap;
    next += taken.length;
  }
  if (!slots.length) return null;
  return { lineup: current, slots, placed: next, left: units.length - next, gaps, stopped: next < units.length ? stopped : undefined };
}
