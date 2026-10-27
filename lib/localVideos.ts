// Music videos and other loose videos in the program bin (D70): who the artist
// is (Tunarr's own field when a media server has one, otherwise read from the
// "Artist - Title" file name), clean titles to show, grouping by artist, and a
// shuffle that keeps the same artist from airing twice in a row.
import { artistKey, parseVideoTitle, naturalCompare, type VideoKind } from '../server/videoTitles';
import type { ContentProgram, LibraryItem } from './library';

/** Library types whose titles are often just a file name. */
export const LOOSE_VIDEO_TYPES = new Set(['music_video', 'other_video']);

type Meta = { type?: unknown; title?: unknown; artist?: unknown; grandparent?: { title?: unknown }; parent?: { title?: unknown } };
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const kindOf = (type: unknown): VideoKind => (type === 'other_video' ? 'videos' : 'music-videos');

/** The artist of a music video or track, or of a loose video named "Artist - Title". */
export function artistOf(item: LibraryItem | ContentProgram['program'] | Record<string, unknown>): string | undefined {
  const meta = item as Meta;
  const own = text(meta.artist) ?? text((meta.artist as { title?: unknown } | undefined)?.title);
  if (own) return own;
  if (meta.type === 'track') return text(meta.grandparent?.title);
  if (meta.type === 'music_video' && text(meta.parent?.title)) return text(meta.parent?.title);
  if (!LOOSE_VIDEO_TYPES.has(String(meta.type))) return undefined;
  return parseVideoTitle(String(meta.title ?? ''), kindOf(meta.type)).artist;
}

/** A loose video's title without download tags; with `withArtist: false`, without the artist too (when grouped under it). */
export function videoLabel(item: LibraryItem, withArtist = true): string {
  if (!LOOSE_VIDEO_TYPES.has(item.type)) return item.title;
  const parsed = parseVideoTitle(item.title, kindOf(item.type));
  return withArtist ? parsed.display : parsed.title;
}

export type ArtistGroup = { key: string; artist: string; items: LibraryItem[] };

/** Items grouped by artist, artists in name order; those with no artist come last, in one group with an empty key. */
export function groupByArtist(items: LibraryItem[]): ArtistGroup[] {
  const groups = new Map<string, ArtistGroup>();
  const loose: LibraryItem[] = [];
  for (const item of items) {
    const artist = artistOf(item);
    if (!artist) { loose.push(item); continue; }
    const key = artistKey(artist) || artist.toLowerCase();
    const group = groups.get(key) ?? { key, artist, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => naturalCompare(a.key, b.key));
  for (const group of sorted) group.items.sort((a, b) => naturalCompare(videoLabel(a, false), videoLabel(b, false)));
  return loose.length ? [...sorted, { key: '', artist: '', items: loose }] : sorted;
}

/** The artist, or for a video with none, the video itself (so the same clip isn't repeated back to back either). */
const keyOf = (program: ContentProgram) => {
  const artist = artistOf(program.program ?? {});
  return artist ? artistKey(artist) || artist : `#${program.id}`;
};

/**
 * Shuffled, with each artist kept `gap` programs from its last airing where
 * the mix allows (by default 3, or fewer when there are only a few artists or
 * one artist has a large share).
 * Programs with no artist are each their own. Each next program comes from an
 * artist that isn't too recent, drawn in proportion to what it has left; an
 * artist with so many left that it would bunch up at the end goes first.
 * `before`: what airs just ahead (the last pass), so spacing carries across.
 */
export function spreadArtists(programs: ContentProgram[], random: () => number = Math.random, gap?: number, before: ContentProgram[] = []): ContentProgram[] {
  const queues = new Map<string, ContentProgram[]>();
  programs.forEach((program) => {
    const key = keyOf(program);
    queues.set(key, [...(queues.get(key) ?? []), program]);
  });
  // Each artist's own videos shuffled too.
  for (const [key, queue] of queues) {
    for (let at = queue.length - 1; at > 0; at -= 1) {
      const other = Math.floor(random() * (at + 1));
      [queue[at], queue[other]] = [queue[other], queue[at]];
    }
    queues.set(key, queue);
  }
  // No wider than the mix allows even when it repeats: an artist with `most` of `n` videos can be `n / most - 1` apart.
  const most = Math.max(1, ...[...queues.values()].map((queue) => queue.length));
  const spacing = Math.max(0, Math.min(gap ?? 3, queues.size - 1, Math.floor(programs.length / most) - 1));
  const recent: string[] = spacing ? before.slice(-spacing).map(keyOf).filter((key) => queues.has(key)) : [];
  const out: ContentProgram[] = [];
  let left = programs.length;
  while (left > 0) {
    const open = [...queues.entries()].filter(([key, queue]) => queue.length && !recent.includes(key));
    // Everyone left aired too recently: the one aired longest ago goes.
    const pool = open.length ? open : [...queues.entries()].filter(([, queue]) => queue.length).sort(([a], [b]) => recent.indexOf(a) - recent.indexOf(b)).slice(0, 1);
    const largest = pool.reduce((best, entry) => (entry[1].length > best[1].length ? entry : best), pool[0]);
    let chosen = largest;
    // Only when no artist is crowding the end is the draw left to chance.
    if (largest[1].length * (spacing + 1) <= left) {
      let draw = random() * pool.reduce((sum, [, queue]) => sum + queue.length, 0);
      chosen = pool.find(([, queue]) => (draw -= queue.length) < 0) ?? largest;
    }
    out.push(chosen[1].shift()!);
    left -= 1;
    recent.push(chosen[0]);
    if (recent.length > spacing) recent.shift();
  }
  return out;
}
