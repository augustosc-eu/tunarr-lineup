// The schedule library and the calendar (roadmap milestone 4, D66), kept by
// the companion in LINEUP_DATA_DIR: schedule-library.json holds lineups saved
// apart from any channel (with titles for their programs), calendar.json the
// entries that put them on channels on dates, with a short history of each
// occurrence (armed, skipped, outranked). Both go through jsonFile: atomic
// writes, and a file that can't be parsed is reported, never overwritten.
import { randomUUID } from 'node:crypto';
import type { CalendarEntryInput } from './calendar.js';
import { createJsonFile, StoreError } from './jsonFile.js';
import { lineupItemsError, slimPrograms } from './lineupItems.js';
import { lineupLength } from './lineupVersion.js';

export const MAX_LIBRARY_ENTRIES = 100;
export const MAX_LIBRARY_ITEMS = 20_000;
export const MAX_CALENDAR_ENTRIES = 100;
const MAX_HISTORY = 100;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isStoreId = (value: string) => ID.test(value);
export const ORIGINS = ['desk', 'slot-preview', 'package', 'snapshot', 'planner'] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max && !CONTROL.test(value) ? value.trim() : null);

// ------------------------------------------------------------------ library

export type LibraryEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Where it came from: the desk's edits, a slot preview, a package, a snapshot; and the channel, for reference. */
  origin: { kind: (typeof ORIGINS)[number]; channelName: string };
  lineup: Array<Record<string, unknown>>;
  programs: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};
export type LibrarySummary = Omit<LibraryEntry, 'lineup' | 'programs'> & { items: number; length: number };

export function librarySummary(entry: LibraryEntry): LibrarySummary {
  const rest: Partial<LibraryEntry> = { ...entry };
  delete rest.lineup;
  delete rest.programs;
  return { ...(rest as Omit<LibraryEntry, 'lineup' | 'programs'>), items: entry.lineup.length, length: lineupLength(entry.lineup) };
}

type Details = Pick<LibraryEntry, 'name' | 'description' | 'tags'>;

/** Name, description and tags; `partial` for an edit (what's left out is kept). */
export function validateDetails(raw: Json, partial: boolean): Partial<Details> | { error: string } {
  const out: Partial<Details> = {};
  if (!partial || 'name' in raw) {
    const name = text(raw.name, 120);
    if (!name) return { error: 'Give it a name (up to 120 characters).' };
    out.name = name;
  }
  if (!partial || 'description' in raw) {
    const description = raw.description === undefined ? '' : text(raw.description, 1000);
    if (description === null) return { error: 'The description is up to 1,000 characters.' };
    out.description = description;
  }
  if (!partial || 'tags' in raw) {
    const tags = raw.tags === undefined ? [] : raw.tags;
    if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => !text(tag, 40))) return { error: 'Up to 10 tags of up to 40 characters.' };
    out.tags = [...new Set((tags as string[]).map((tag) => tag.trim()).filter(Boolean))];
  }
  return out;
}

export function validateLibraryEntry(raw: unknown): Omit<LibraryEntry, 'id' | 'createdAt' | 'updatedAt'> | { error: string } {
  if (!isObject(raw)) return { error: 'Send the schedule as an object.' };
  const details = validateDetails(raw, false);
  if ('error' in details) return details;
  const origin = isObject(raw.origin) ? raw.origin : {};
  if (!(ORIGINS as readonly unknown[]).includes(origin.kind)) return { error: 'Say where the schedule comes from.' };
  const problem = lineupItemsError(raw.lineup);
  if (problem) return { error: problem };
  const lineup = raw.lineup as Array<Record<string, unknown>>;
  if (!lineup.length) return { error: 'An empty lineup can’t be saved.' };
  if (lineup.length > MAX_LIBRARY_ITEMS) return { error: `A saved schedule holds up to ${MAX_LIBRARY_ITEMS.toLocaleString('en')} items.` };
  return {
    ...(details as Details), origin: { kind: origin.kind as LibraryEntry['origin']['kind'], channelName: text(origin.channelName, 120) ?? '' },
    lineup, programs: slimPrograms(lineup, raw.programs),
  };
}

export type ScheduleLibrary = {
  list(): Promise<LibraryEntry[]>;
  get(id: string): Promise<LibraryEntry | undefined>;
  create(entry: Omit<LibraryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<LibraryEntry>;
  update(id: string, details: Partial<Details>): Promise<LibraryEntry | undefined>;
  remove(id: string): Promise<boolean>;
};

export function createScheduleLibrary(dataDir: string): ScheduleLibrary {
  const file = createJsonFile(dataDir, 'schedule-library.json', 'schedule library');
  const read = async (): Promise<LibraryEntry[]> => {
    const data = await file.read();
    return (isObject(data) && Array.isArray(data.schedules) ? data.schedules : []).filter((item): item is LibraryEntry => isObject(item) && typeof item.id === 'string' && Array.isArray(item.lineup));
  };
  const write = (entries: LibraryEntry[]) => file.write({ version: 1, schedules: entries });
  return {
    list: () => file.serialize(read),
    get: (id) => file.serialize(async () => (await read()).find((entry) => entry.id === id)),
    create: (input) => file.serialize(async () => {
      const entries = await read();
      if (entries.length >= MAX_LIBRARY_ENTRIES) throw new StoreError(409, 'library_full', `The library holds up to ${MAX_LIBRARY_ENTRIES} schedules. Delete one first.`);
      const now = Date.now();
      const entry: LibraryEntry = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
      await write([entry, ...entries]);
      return entry;
    }),
    update: (id, details) => file.serialize(async () => {
      const entries = await read();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return undefined;
      Object.assign(entry, details, { updatedAt: Date.now() });
      await write(entries);
      return entry;
    }),
    remove: (id) => file.serialize(async () => {
      const entries = await read();
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return false;
      await write(next);
      return true;
    }),
  };
}

// ----------------------------------------------------------------- calendar

/** What happened to one occurrence on one channel. */
export type OccurrenceRecord = {
  key: string;
  channelId: string;
  start: number;
  end: number | null;
  status: 'armed' | 'suppressed' | 'skipped';
  /** The scheduler plan it became, when armed. */
  planId?: string;
  message: string;
  at: number;
};

export type CalendarEntry = CalendarEntryInput & { id: string; createdAt: number; updatedAt: number; history: OccurrenceRecord[] };

export type CalendarStore = {
  list(): Promise<CalendarEntry[]>;
  get(id: string): Promise<CalendarEntry | undefined>;
  create(input: CalendarEntryInput): Promise<CalendarEntry>;
  update(id: string, input: CalendarEntryInput): Promise<CalendarEntry | undefined>;
  remove(id: string): Promise<CalendarEntry | undefined>;
  /** Adds an occurrence record (the newest first; bounded). */
  record(id: string, record: OccurrenceRecord): Promise<void>;
  /** Forgets occurrence records, so those occurrences are armed again (their plans were cancelled as no longer right). */
  release(id: string, keys: string[]): Promise<void>;
};

export function createCalendarStore(dataDir: string): CalendarStore {
  const file = createJsonFile(dataDir, 'calendar.json', 'programming calendar');
  const read = async (): Promise<CalendarEntry[]> => {
    const data = await file.read();
    return (isObject(data) && Array.isArray(data.entries) ? data.entries : []).filter((item): item is CalendarEntry => isObject(item) && typeof item.id === 'string' && isObject(item.recurrence) && Array.isArray(item.channelIds))
      .map((entry) => ({ ...entry, history: Array.isArray(entry.history) ? entry.history : [] }));
  };
  const write = (entries: CalendarEntry[]) => file.write({ version: 1, entries });
  return {
    list: () => file.serialize(read),
    get: (id) => file.serialize(async () => (await read()).find((entry) => entry.id === id)),
    create: (input) => file.serialize(async () => {
      const entries = await read();
      if (entries.length >= MAX_CALENDAR_ENTRIES) throw new StoreError(409, 'calendar_full', `The calendar holds up to ${MAX_CALENDAR_ENTRIES} entries.`);
      const now = Date.now();
      const entry: CalendarEntry = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, history: [] };
      await write([...entries, entry]);
      return entry;
    }),
    update: (id, input) => file.serialize(async () => {
      const entries = await read();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return undefined;
      Object.assign(entry, input, { updatedAt: Date.now() });
      await write(entries);
      return entry;
    }),
    remove: (id) => file.serialize(async () => {
      const entries = await read();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return undefined;
      await write(entries.filter((item) => item.id !== id));
      return entry;
    }),
    record: (id, record) => file.serialize(async () => {
      const entries = await read();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      entry.history = [record, ...entry.history.filter((item) => item.key !== record.key)].slice(0, MAX_HISTORY);
      await write(entries);
    }),
    release: (id, keys) => file.serialize(async () => {
      const entries = await read();
      const entry = entries.find((item) => item.id === id);
      if (!entry || !entry.history.some((item) => keys.includes(item.key))) return;
      entry.history = entry.history.filter((item) => !keys.includes(item.key));
      await write(entries);
    }),
  };
}
