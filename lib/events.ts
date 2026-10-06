// Date-specific events (a match, a premiere, a special): placed into the
// lineup at the program boundary nearest a chosen date and time. Tunarr can't
// cut a program short, so an event starts when a program starts. "Replace"
// takes out what would have aired and pads with flex so everything after the
// event keeps its time; "Push" moves everything after the event later.
import { makeFlex } from './broadcast';
import type { LineupItem } from './lineup';

export type EventMode = 'replace' | 'push';
export type EventSnap = 'after' | 'before';
/** Where Insert puts new items: next to the selection, or at a date and time. */
export type InsertWhere = 'before' | 'after' | { at: number; snap: EventSnap };

/** "Tue 6 Oct, 20:00:00": when something airs. */
export const airTimeLabel = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));

export type EventPlacement = {
  lineup: LineupItem[];
  /** Index of the first event item in the new lineup. */
  index: number;
  count: number;
  /** When the event actually starts and ends (ms). */
  start: number;
  end: number;
  /** How far the start is from the requested time (ms; positive = later). */
  drift: number;
  /** What the event takes off the air (replace mode). */
  removed: LineupItem[];
  /** Flex added after the event to keep later programs on time (replace mode). */
  pad: number;
  /**
   * How far a replace-mode event runs past the end of the lineup (ms). The
   * cycle can't wrap, so the lineup grows by this much and later repeats move.
   */
  overrun: number;
  /** How often the new lineup repeats (ms), so the event repeats too. */
  cycle: number;
};

const total = (items: LineupItem[]) => items.reduce((sum, item) => sum + item.duration, 0);

/**
 * The lineup position at the program boundary at or after (or at or before)
 * `at`, and when items inserted there start. The lineup repeats from the
 * channel's start, so adding `added` ms lengthens every earlier pass and moves
 * later ones: the boundary is found on the new cycle, which makes `start`
 * where the items will really air. Null when the lineup is empty.
 */
export function boundaryAt(lineup: LineupItem[], channelStart: number, at: number, snap: EventSnap = 'after', added = 0): { index: number; start: number } | null {
  const length = total(lineup);
  const cycle = length + added;
  if (!lineup.length || length <= 0 || !Number.isFinite(at)) return null;
  // Which pass through the lineup `at` falls in, and where inside it.
  const pass = Math.floor((at - channelStart) / cycle);
  const passStart = channelStart + pass * cycle;
  const offset = at - passStart;
  let index = 0;
  let cursor = 0;
  while (index < lineup.length && cursor + lineup[index].duration <= offset) {
    cursor += lineup[index].duration;
    index += 1;
  }
  if (cursor === offset || snap === 'before') return { index, start: passStart + cursor };
  // `at` is inside lineup[index] (or, past the old end, inside what's added
  // there): start when it ends, which may be the start of the next pass.
  return index < lineup.length
    ? { index: index + 1, start: passStart + cursor + lineup[index].duration }
    : { index: 0, start: passStart + cycle };
}

/**
 * When items of `added` ms inserted at `index` start, on the pass of the
 * lineup that airs around `near` (the row they're inserted next to). Every
 * earlier pass grows by `added`, so on a channel that has already repeated,
 * this is later than the spot on screen.
 */
export function insertedStart(lineup: LineupItem[], channelStart: number, index: number, near: number, added: number, newStart = channelStart) {
  const length = total(lineup);
  if (!lineup.length || length <= 0) return null;
  const pass = Math.floor((near - channelStart) / length);
  // `newStart`: the channel start after the insert, if it moves too (keeping what's on air in place).
  return newStart + pass * (length + added) + total(lineup.slice(0, index));
}

/** How many times the lineup has played through by `at`. */
export function passesBefore(lineup: LineupItem[], channelStart: number, at: number) {
  const length = total(lineup);
  return length > 0 ? Math.max(0, Math.floor((at - channelStart) / length)) : 0;
}

/**
 * Places `event` items at the boundary at or after (or at or before) `at`.
 * Returns null when the lineup is empty or the event has no length.
 */
export function placeEvent(lineup: LineupItem[], channelStart: number, at: number, event: LineupItem[], mode: EventMode, snap: EventSnap = 'after'): EventPlacement | null {
  const length = total(event);
  // Pushing lengthens the cycle; replacing keeps it (an overrun is reported).
  const boundary = boundaryAt(lineup, channelStart, at, snap, mode === 'push' ? length : 0);
  if (!boundary || length <= 0) return null;
  const { index, start } = boundary;
  let removed: LineupItem[] = [];
  let pad = 0;
  let overrun = 0;
  let next: LineupItem[];
  if (mode === 'replace') {
    let end = index;
    let taken = 0;
    while (end < lineup.length && taken < length) {
      taken += lineup[end].duration;
      end += 1;
    }
    removed = lineup.slice(index, end);
    pad = Math.max(0, taken - length);
    overrun = Math.max(0, length - taken);
    next = [...lineup.slice(0, index), ...event, ...(pad > 0 ? [makeFlex(pad)] : []), ...lineup.slice(end)];
  } else {
    next = [...lineup.slice(0, index), ...event, ...lineup.slice(index)];
  }
  return { lineup: next, index, count: event.length, start, end: start + length, drift: start - at, removed, pad, overrun, cycle: total(next) };
}

/** "every 30 days", "every 6 hours" — how often a lineup of this length repeats. */
export function repeatLabel(cycle: number) {
  const days = cycle / 86_400_000;
  if (days >= 2) return `every ${Math.round(days * 10) / 10} days`;
  const hours = cycle / 3_600_000;
  return hours >= 1 ? `every ${Math.round(hours * 10) / 10} hours` : `every ${Math.round(cycle / 60_000)} minutes`;
}
