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
