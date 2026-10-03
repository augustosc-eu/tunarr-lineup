// Step-by-step edit history (undo/redo) over whole-lineup snapshots.
// Snapshots share item objects, so each entry costs one array.
import type { LineupItem } from './lineup';
import type { Block } from './broadcast';

export type HistoryEntry = {
  label: string;
  before: LineupItem[];
  after: LineupItem[];
  /** Selection after the edit, so undo/redo can restore focus sensibly. */
  blockBefore: Block;
  blockAfter: Block;
};

export type History = { past: HistoryEntry[]; future: HistoryEntry[] };

export const MAX_HISTORY = 200;

export const emptyHistory: History = { past: [], future: [] };

export function record(history: History, entry: HistoryEntry): History {
  return { past: [...history.past, entry].slice(-MAX_HISTORY), future: [] };
}

export function undo(history: History): { history: History; entry: HistoryEntry } | null {
  const entry = history.past.at(-1);
  if (!entry) return null;
  return { history: { past: history.past.slice(0, -1), future: [entry, ...history.future] }, entry };
}

export function redo(history: History): { history: History; entry: HistoryEntry } | null {
  const [entry, ...rest] = history.future;
  if (!entry) return null;
  return { history: { past: [...history.past, entry], future: rest }, entry };
}

/** What makes two lineup entries "the same item" across a save round trip. */
export function itemIdentity(item: LineupItem) {
  const field = (name: string) => (typeof item[name] === 'string' || typeof item[name] === 'number' ? String(item[name]) : '');
  return [item.type, field('id'), field('channel'), field('customShowId'), field('fillerListId'), field('index'), item.duration].join('|');
}

/**
 * After a save, Tunarr returns fresh objects for the lineup that was saved.
 * Re-points every history snapshot at those objects so undo keeps working
 * past the save. Returns null when the saved and returned lineups don't line
 * up item for item (e.g. Tunarr dropped or changed entries).
 */
export function rebaseHistory(history: History, saved: LineupItem[], fresh: LineupItem[]): History | null {
  if (saved.length !== fresh.length) return null;
  const mapping = new Map<LineupItem, LineupItem>();
  for (let index = 0; index < saved.length; index += 1) {
    if (itemIdentity(saved[index]) !== itemIdentity(fresh[index])) return null;
    mapping.set(saved[index], fresh[index]);
  }
  // Entries no longer in the saved lineup (removed before saving) keep their
  // own objects, so undoing a removal still restores them.
  const remap = (lineup: LineupItem[]) => lineup.map((item) => mapping.get(item) ?? item);
  const entry = (item: HistoryEntry): HistoryEntry => ({ ...item, before: remap(item.before), after: remap(item.after) });
  return { past: history.past.map(entry), future: history.future.map(entry) };
}
