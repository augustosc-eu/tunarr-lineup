// Checks shared by every route that takes lineup items from the browser:
// manual saves, scheduled changes, shared drafts and imported snapshots.
// Items are passed through untouched once they pass (invariant 3).

export const MAX_LINEUP_ITEMS = 100_000;
const LINEUP_ITEM_TYPES = new Set(['content', 'custom', 'filler', 'flex', 'redirect']);
const ITEM_ID_REQUIRED = new Set(['content', 'custom', 'filler']);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** Null when every item is one Tunarr can save, otherwise what's wrong with the first bad one. */
export function lineupItemsError(items: unknown, what = 'Lineup item'): string | null {
  if (!Array.isArray(items)) return '"lineup" must be an array.';
  if (items.length > MAX_LINEUP_ITEMS) return 'Lineup is too large.';
  for (const [index, item] of items.entries()) {
    if (!isObject(item)) return `${what} ${index} must be an object.`;
    if (typeof item.type !== 'string' || !LINEUP_ITEM_TYPES.has(item.type)) return `${what} ${index} has an unsupported type.`;
    if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration <= 0) return `${what} ${index} needs a positive duration.`;
    if (ITEM_ID_REQUIRED.has(item.type) && (typeof item.id !== 'string' || !item.id)) return `${what} ${index} is missing its program id.`;
    if (item.type === 'redirect' && typeof item.channel !== 'string') return `${what} ${index} is missing its redirect channel.`;
  }
  return null;
}

const PROGRAM_FIELDS = ['type', 'title', 'year', 'episodeNumber', 'seasonNumber', 'showTitle', 'artistName', 'albumName', 'rating'] as const;

/**
 * Just enough of each program to title it later (title, show, season and
 * episode), for the programs a lineup plays. Kept with snapshots and scheduled
 * changes, so a lineup shown weeks later still reads as more than ids.
 */
export function slimPrograms(lineup: unknown, programs: unknown, max = 20_000): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (!Array.isArray(lineup) || !isObject(programs)) return out;
  // Counted rather than Object.keys(out) per item, which made a 20,000-item lineup take a third of a second.
  let count = 0;
  for (const item of lineup) {
    if (count >= max) break;
    const id = isObject(item) && typeof item.id === 'string' ? item.id : '';
    if (!id || Object.hasOwn(out, id)) continue;
    const entry = programs[id];
    const program = isObject(entry) && isObject(entry.program) ? entry.program : entry;
    if (!isObject(program)) continue;
    const slim: Json = {};
    for (const field of PROGRAM_FIELDS) {
      const value = program[field];
      if (typeof value === 'string') slim[field] = value.slice(0, 300);
      else if (typeof value === 'number' && Number.isFinite(value)) slim[field] = value;
    }
    const show = isObject(program.show) && typeof program.show.title === 'string' ? program.show.title : isObject(program.season) && isObject(program.season.show) && typeof program.season.show.title === 'string' ? program.season.show.title : undefined;
    if (show) slim.show = { title: show.slice(0, 300) };
    const season = isObject(program.season) ? program.season.index ?? program.season.number : undefined;
    if (slim.seasonNumber === undefined && typeof season === 'number') slim.seasonNumber = season;
    out[id] = slim;
    count += 1;
  }
  return out;
}

/** A programs map sent by the browser, reduced to slim entries (anything else is dropped). */
export function sanitizePrograms(programs: unknown, lineup: unknown): Record<string, Json> {
  return slimPrograms(lineup, programs);
}
