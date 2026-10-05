// Date-specific events (a match, a premiere, a special): placed into the
// lineup at the program boundary nearest a chosen date and time. Tunarr can't
// cut a program short, so an event starts when a program starts. "Replace"
// takes out what would have aired and pads with flex so everything after the
// event keeps its time; "Push" moves everything after the event later.
import { makeFlex } from './broadcast';
import type { LineupItem } from './lineup';

export type EventMode = 'replace' | 'push';
export type EventSnap = 'after' | 'before';

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
 * Places `event` items at the boundary at or after (or at or before) `at`.
 * Returns null when the lineup is empty or the event has no length.
 */
export function placeEvent(lineup: LineupItem[], channelStart: number, at: number, event: LineupItem[], mode: EventMode, snap: EventSnap = 'after'): EventPlacement | null {
  const cycle = total(lineup);
  const length = total(event);
  if (!lineup.length || cycle <= 0 || length <= 0) return null;
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
  // `index` is the item airing at `at` and `cursor` its start within the pass.
  if (cursor !== offset && snap === 'after') {
    cursor += lineup[index].duration;
    index += 1;
  }
  const start = passStart + cursor;
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
