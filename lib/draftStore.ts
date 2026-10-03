// Per-channel drafts (unsaved order + undo history) kept in the browser so
// they survive reloads, channel switches and the TV being turned off.
//
// A draft is stored relative to the exact programming version it was made
// against: every lineup state is a list of indices into that version's
// lineup. If Tunarr's lineup has changed since, the draft no longer applies
// and is dropped.
import type { Block } from './broadcast';
import type { History, HistoryEntry } from './history';
import type { LineupItem } from './lineup';

type StoredEntry = { label: string; before: number[]; after: number[]; blockBefore: Block; blockAfter: Block };

export type StoredDraft = {
  channelId: string;
  version: string;
  updatedAt: number;
  dirty: boolean;
  current: number[];
  past: StoredEntry[];
  future: StoredEntry[];
};

export type DraftStore = {
  /** False when only in-memory storage is available (lost on reload). */
  readonly persistent: boolean;
  get(channelId: string): Promise<StoredDraft | undefined>;
  put(draft: StoredDraft): Promise<void>;
  delete(channelId: string): Promise<void>;
  list(): Promise<StoredDraft[]>;
};

export const MAX_DRAFTS = 60;
const DB_NAME = 'tunarr-lineup';
const STORE = 'drafts';

export function encodeDraft(channelId: string, version: string, base: LineupItem[], current: LineupItem[], history: History, dirty: boolean): StoredDraft | null {
  const position = new Map<LineupItem, number>(base.map((item, index) => [item, index]));
  const encode = (lineup: LineupItem[]) => {
    const indices = lineup.map((item) => position.get(item));
    return indices.every((index) => index !== undefined) ? (indices as number[]) : null;
  };
  const entry = (item: HistoryEntry): StoredEntry | null => {
    const before = encode(item.before);
    const after = encode(item.after);
    return before && after ? { label: item.label, before, after, blockBefore: item.blockBefore, blockAfter: item.blockAfter } : null;
  };
  const encodedCurrent = encode(current);
  const past = history.past.map(entry);
  const future = history.future.map(entry);
  if (!encodedCurrent || past.includes(null) || future.includes(null)) return null;
  return { channelId, version, updatedAt: Date.now(), dirty, current: encodedCurrent, past: past as StoredEntry[], future: future as StoredEntry[] };
}

export function decodeDraft(draft: StoredDraft, base: LineupItem[]): { current: LineupItem[]; history: History } | null {
  const decode = (indices: unknown) => {
    if (!Array.isArray(indices) || indices.length !== base.length) return null;
    const items = indices.map((index) => (Number.isInteger(index) ? base[index as number] : undefined));
    return items.every(Boolean) ? (items as LineupItem[]) : null;
  };
  const entry = (item: StoredEntry): HistoryEntry | null => {
    const before = decode(item.before);
    const after = decode(item.after);
    return before && after ? { label: String(item.label), before, after, blockBefore: item.blockBefore, blockAfter: item.blockAfter } : null;
  };
  const current = decode(draft.current);
  const past = (draft.past ?? []).map(entry);
  const future = (draft.future ?? []).map(entry);
  if (!current || past.includes(null) || future.includes(null)) return null;
  return { current, history: { past: past as HistoryEntry[], future: future as HistoryEntry[] } };
}

function memoryStore(): DraftStore {
  const drafts = new Map<string, StoredDraft>();
  return {
    persistent: false,
    async get(channelId) { return drafts.get(channelId); },
    async put(draft) { drafts.set(draft.channelId, draft); },
    async delete(channelId) { drafts.delete(channelId); },
    async list() { return [...drafts.values()]; },
  };
}

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function indexedDbStore(factory: IDBFactory): DraftStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'channelId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    persistent: true,
    async get(channelId) { return request<StoredDraft | undefined>((await store('readonly')).get(channelId)); },
    async put(draft) {
      await request((await store('readwrite')).put(draft));
      const all = await request<StoredDraft[]>((await store('readonly')).getAll());
      if (all.length > MAX_DRAFTS) {
        const stale = all.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, all.length - MAX_DRAFTS);
        const writable = await store('readwrite');
        await Promise.all(stale.map((item) => request(writable.delete(item.channelId))));
      }
    },
    async delete(channelId) { await request((await store('readwrite')).delete(channelId)); },
    async list() { return request<StoredDraft[]>((await store('readonly')).getAll()); },
  };
}

/** IndexedDB when it works; otherwise an in-memory store (private mode, old TVs, tests). */
export function createDraftStore(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): DraftStore {
  if (!factory) return memoryStore();
  const durable = indexedDbStore(factory);
  const fallback = memoryStore();
  let broken = false;
  const guarded = <A extends unknown[], R>(method: (...args: A) => Promise<R>, backup: (...args: A) => Promise<R>) => async (...args: A) => {
    if (broken) return backup(...args);
    try {
      return await method(...args);
    } catch {
      broken = true;
      return backup(...args);
    }
  };
  return {
    get persistent() { return !broken; },
    get: guarded(durable.get, fallback.get),
    put: guarded(durable.put, fallback.put),
    delete: guarded(durable.delete, fallback.delete),
    list: guarded(durable.list, fallback.list),
  };
}

let shared: DraftStore | undefined;
export const draftStore = () => (shared ??= createDraftStore());
