// The program bin: picked library programs, arranged into lineup items with
// the options chosen for them (order, repeats, what airs after each one).
import { makeBreakWithId, makeCommercialBreak, makeFlex } from './broadcast';
import type { InsertWhere } from './events';
import type { ContentProgram } from './library';
import type { LineupItem } from './lineup';

/** Where placed programs go: the Insert dialog's places, the end of the lineup, or a lineup position (a drop on a row, near that row's airing). */
export type PlaceWhere = InsertWhere | 'end' | { index: number; near: number };

export type BinOrder = 'picked' | 'episode' | 'shuffle';

export const BIN_ORDER_LABELS: Record<BinOrder, string> = {
  picked: 'As picked',
  episode: 'Episode order',
  shuffle: 'Shuffle',
};

/** What airs after each program: nothing, open airtime, or a commercial break (optionally opened by a station ID). */
export type BinAfter =
  | { kind: 'none' }
  | { kind: 'flex'; duration: number }
  | { kind: 'break'; duration: number; fillerListIds: string[]; stationIds?: Array<{ id: string; duration: number }> };

export type BinOptions = { order: BinOrder; repeat: number; after: BinAfter };

export const DEFAULT_BIN_OPTIONS: BinOptions = { order: 'picked', repeat: 1, after: { kind: 'none' } };
export const MAX_BIN_REPEAT = 20;

export type Arranged = { items: LineupItem[]; meta: Record<string, ContentProgram>; programs: ContentProgram[] };

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
 * Lineup items for the picked programs. Zero-length programs are left out.
 * Each repeat is a new pass in the chosen order (a shuffle is reshuffled), and
 * station IDs rotate from one break to the next.
 */
export function arrangePrograms(picked: ContentProgram[], options: BinOptions, random: () => number = Math.random): Arranged {
  const playable = picked.filter((program) => program.duration > 0);
  const repeat = Math.min(MAX_BIN_REPEAT, Math.max(1, Math.round(options.repeat) || 1));
  const programs: ContentProgram[] = [];
  for (let pass = 0; pass < repeat; pass += 1) {
    programs.push(...(options.order === 'episode' ? episodeOrder(playable) : options.order === 'shuffle' ? shuffled(playable, random) : playable));
  }
  const items: LineupItem[] = [];
  const meta: Record<string, ContentProgram> = {};
  const after = options.after;
  const ids = after.kind === 'break' ? (after.stationIds ?? []).filter((id) => id.duration > 0 && id.duration < after.duration) : [];
  let nextId = 0;
  for (const program of programs) {
    items.push({ type: 'content', id: program.id, duration: program.duration });
    meta[program.id] = program;
    if (after.kind === 'flex' && after.duration >= 1000) items.push(makeFlex(after.duration));
    if (after.kind === 'break' && after.duration >= 1000 && after.fillerListIds.length) {
      const id = ids.length ? ids[nextId++ % ids.length] : undefined;
      items.push(...(id ? makeBreakWithId(after.duration, after.fillerListIds, id) : [makeCommercialBreak(after.duration, after.fillerListIds)]));
    }
  }
  return { items, meta, programs };
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
