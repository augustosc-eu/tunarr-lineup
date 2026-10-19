// The guide grid: every channel down the side, time across, like a cable box.
// Pure helpers for its window and for moving between programs with a remote.
import type { GuideChannel, GuideEntry } from '../server/watch';

export type { GuideChannel, GuideEntry };

export const GRID_STEP_MS = 30 * 60_000;

/** The grid's window opens on the half hour at or before `time`. */
export const windowStart = (time: number) => {
  const date = new Date(time);
  date.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);
  return date.getTime();
};

export type Cell = { entry: GuideEntry; index: number; left: number; width: number; clippedStart: boolean; clippedEnd: boolean };

/** Where each program sits in a window [from, to), in percent. */
export function cellsFor(programs: GuideEntry[], from: number, to: number): Cell[] {
  const span = to - from;
  return programs.flatMap((entry, index) => {
    const start = Math.max(entry.start, from);
    const stop = Math.min(entry.stop, to);
    if (stop <= start) return [];
    return [{ entry, index, left: ((start - from) / span) * 100, width: ((stop - start) / span) * 100, clippedStart: entry.start < from, clippedEnd: entry.stop > to }];
  });
}

/** The program airing at `time` on a channel, or -1. */
export const entryAt = (programs: GuideEntry[], time: number) => programs.findIndex((entry) => entry.start <= time && time < entry.stop);

/**
 * Moving the focus left or right: to the start of the previous program, or
 * of the next one. Returns the new focus time, or null at the end of the data.
 */
export function stepFocus(programs: GuideEntry[], time: number, direction: -1 | 1): number | null {
  const at = entryAt(programs, time);
  if (at < 0) {
    // Between programs (or before the data): go to the nearest one in that direction.
    const next = direction > 0 ? programs.find((entry) => entry.start > time) : [...programs].reverse().find((entry) => entry.stop <= time);
    return next ? next.start : null;
  }
  const target = programs[at + direction];
  return target ? target.start : null;
}

/** Channels grouped by Tunarr's group title (the "network"), in channel-number order. */
export function byNetwork<T extends { number: number; groupTitle?: string }>(channels: T[]): Array<{ network: string; channels: T[] }> {
  const groups = new Map<string, T[]>();
  for (const channel of [...channels].sort((a, b) => a.number - b.number)) {
    const name = channel.groupTitle?.trim() || 'Other channels';
    groups.set(name, [...(groups.get(name) ?? []), channel]);
  }
  return [...groups].map(([network, list]) => ({ network, channels: list }));
}
