// Pure lineup helpers shared by the interface and its tests.

export type LineupItem = {
  type: string;
  duration: number;
  id?: string;
  icon?: string;
  [key: string]: unknown;
};

export type Program = {
  title?: string;
  year?: number | null;
  type?: string;
  episodeNumber?: number;
  seasonNumber?: number;
  season?: { index?: number; number?: number; title?: string; show?: { title?: string } };
  show?: { title?: string };
  showTitle?: string;
  artistName?: string;
  albumName?: string;
  artwork?: Array<{ type?: string; path?: string | null }>;
  [key: string]: unknown;
};

export type Programming = {
  lineup: LineupItem[];
  programs: Record<string, { program?: Program } | Program>;
  schedule?: unknown;
  totalPrograms?: number;
  startTimeOffsets?: number[];
  [key: string]: unknown;
};

export type Channel = {
  id: string;
  name: string;
  number: number;
  startTime: number;
  duration: number;
  programCount?: number;
  icon?: { path?: string };
};

export type GuideProgram = {
  type: string;
  start: number;
  stop: number;
  id?: string;
  title?: string;
  program?: Program;
  channelName?: string;
  [key: string]: unknown;
};

export type ChannelLineup = {
  id?: string;
  programs: GuideProgram[];
};

export type Instance = {
  item: LineupItem;
  /** Index into the channel lineup, or -1 for guide-only rows (e.g. inserted filler). */
  lineupIndex: number;
  start: number;
  stop: number;
  title?: string;
};

export type ManualProgrammingRequest = {
  type: 'manual';
  lineup: LineupItem[];
  append: false;
  /** Ask the companion to move the start time so the pass on air keeps its times (keptStartTime). */
  keepOnAir?: boolean;
};

export function dayRange(date: string) {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export function cycleDuration(lineup: LineupItem[]) {
  return lineup.reduce((total, item) => total + Math.max(0, item.duration || 0), 0);
}

/** Projects the repeating lineup onto one local calendar day. */
export function instancesForDay(lineup: LineupItem[], startTime: number, date: string): Instance[] {
  const { from, to } = dayRange(date);
  const dayStart = from.getTime();
  const dayEnd = to.getTime();
  const cycle = cycleDuration(lineup);
  if (!lineup.length || cycle <= 0) return [];
  let cursor = startTime + Math.floor((dayStart - startTime) / cycle) * cycle;
  while (cursor > dayStart) cursor -= cycle;
  const result: Instance[] = [];
  let guard = 0;
  while (cursor < dayEnd && guard < 20_000) {
    lineup.forEach((item, lineupIndex) => {
      const start = cursor;
      const stop = start + Math.max(0, item.duration || 0);
      if (stop > dayStart && start < dayEnd) result.push({ item, lineupIndex, start, stop });
      cursor = stop;
    });
    guard += lineup.length;
  }
  return result;
}

/** Finds which lineup entry is airing at `time`, given the channel's cycle. */
export function lineupIndexAt(lineup: LineupItem[], startTime: number, time: number) {
  const cycle = cycleDuration(lineup);
  if (!lineup.length || cycle <= 0) return -1;
  const position = (((time - startTime) % cycle) + cycle) % cycle;
  let offset = 0;
  for (let index = 0; index < lineup.length; index += 1) {
    const duration = Math.max(0, lineup[index].duration || 0);
    if (position >= offset && position < offset + duration) return index;
    offset += duration;
  }
  return -1;
}

function sameProgram(item: LineupItem, guide: GuideProgram) {
  if (item.id && guide.id) return item.id === guide.id;
  return !item.id && !guide.id && item.type === guide.type;
}

/**
 * When Tunarr's guide has drifted from the stored lineup (it can lag behind
 * edits), fall back to the occurrence of the same program closest to where
 * the lineup projection expected it.
 */
function nearestById(lineup: LineupItem[], id: string | undefined, near: number) {
  if (!id) return -1;
  let best = -1;
  let bestDistance = Infinity;
  lineup.forEach((item, index) => {
    if (item.id !== id) return;
    const gap = Math.abs(index - Math.max(near, 0));
    const distance = Math.min(gap, lineup.length - gap);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Turns Tunarr's date-range guide into rows. Each guide entry is tied back to
 * the lineup item it came from so it can still be selected and moved; entries
 * Tunarr inserted on its own (filler padding and the like) stay read-only.
 */
export function instancesFromGuide(guide: GuideProgram[], lineup: LineupItem[], startTime: number, date: string): Instance[] {
  const { from, to } = dayRange(date);
  return guide
    .filter((entry) => entry.stop > from.getTime() && entry.start < to.getTime())
    .sort((a, b) => a.start - b.start)
    .map((entry) => {
      const projected = lineupIndexAt(lineup, startTime, entry.start + 1);
      const index = projected >= 0 && sameProgram(lineup[projected], entry) ? projected : nearestById(lineup, entry.id, projected);
      const matched = index >= 0;
      return {
        item: matched ? lineup[index] : { ...entry, duration: entry.stop - entry.start },
        lineupIndex: matched ? index : -1,
        start: entry.start,
        stop: entry.stop,
        title: matched ? undefined : entry.title || entry.program?.title,
      };
    });
}

export type DaySchedule = {
  rows: Instance[];
  /** Part of the day covered by Tunarr's own guide, if any. */
  guideWindow: { start: number; stop: number } | null;
  /** Tunarr's guide disagrees with the lineup (e.g. it has not been rebuilt yet). */
  guideStale: boolean;
};

/**
 * Tunarr only keeps a guide for a window around "now" (roughly the last few
 * hours through the next day). Use its rows wherever it has them and fill the
 * rest of the requested day from the lineup projection.
 */
export function scheduleForDay(guide: GuideProgram[] | null, lineup: LineupItem[], startTime: number, date: string): DaySchedule {
  const projected = instancesForDay(lineup, startTime, date);
  const guideRows = guide ? instancesFromGuide(guide, lineup, startTime, date) : [];
  if (!guideRows.length) return { rows: projected, guideWindow: null, guideStale: false };
  const span = (rows: Instance[]) => rows.reduce((total, row) => total + (row.stop - row.start), 0);
  if (span(guideRows.filter((row) => row.lineupIndex >= 0)) < span(guideRows) / 2) {
    return { rows: projected, guideWindow: null, guideStale: true };
  }
  const start = guideRows[0].start;
  const stop = guideRows[guideRows.length - 1].stop;
  return {
    guideStale: false,
    rows: [
      ...projected.filter((row) => row.stop <= start),
      ...guideRows,
      ...projected.filter((row) => row.start >= stop),
    ],
    guideWindow: { start, stop },
  };
}

/** Moves (before target) or swaps lineup entries. Never adds or drops items. */
export function reorderLineup(lineup: LineupItem[], from: number, to: number, swap = false) {
  if (from === to || from < 0 || to < 0 || from >= lineup.length || to >= lineup.length) return null;
  const next = [...lineup];
  if (swap) {
    [next[from], next[to]] = [next[to], next[from]];
    return { lineup: next, selectedIndex: to };
  }
  const [item] = next.splice(from, 1);
  const target = from < to ? to - 1 : to;
  next.splice(target, 0, item);
  return { lineup: next, selectedIndex: target };
}

/**
 * Builds Tunarr's manual programming request. Lineup objects are passed
 * through untouched so every field Tunarr returned survives the round trip.
 * Zero-length entries are left out because Tunarr will not accept them.
 */
export function buildManualSave(lineup: LineupItem[]): { request: ManualProgrammingRequest; skipped: number } {
  const kept = lineup.filter((item) => typeof item.duration === 'number' && item.duration > 0);
  return { request: { type: 'manual', lineup: kept, append: false }, skipped: lineup.length - kept.length };
}

export function hasGeneratedSchedule(programming: Pick<Programming, 'schedule'>) {
  return programming.schedule != null;
}

export function sameLineup(a: LineupItem[], b: LineupItem[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
