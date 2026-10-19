// Unsaved desk work (order and edit list) kept by the companion, so a draft
// started on the TV is there on a laptop (owner decision 2026-10-19). One file
// per channel (LINEUP_DATA_DIR/drafts/<id>.json). A draft is positions into one
// programming version plus any items it added, exactly as lib/draftStore.ts
// encodes it; the browser drops it once that version is gone from Tunarr.
import path from 'node:path';
import { createJsonFile, StoreError, type JsonFile } from './jsonFile.js';
import { lineupItemsError } from './lineupItems.js';

export const MAX_SHARED_DRAFTS = 120;
const MAX_HISTORY_ENTRIES = 400;
const MAX_POSITION = 200_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[a-z0-9-]{1,64}$/i;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

export type SharedDraft = Json & { channelId: string; version: string; updatedAt: number; dirty: boolean };
export type DraftSummary = { channelId: string; version: string; updatedAt: number; dirty: boolean };

const positions = (value: unknown) => Array.isArray(value) && value.length <= MAX_POSITION && value.every((index) => Number.isInteger(index) && index >= 0 && index < MAX_POSITION);
const block = (value: unknown) => isObject(value) && Number.isInteger(value.start) && Number.isInteger(value.end);

/** Checks a draft's shape (lib/draftStore.ts `StoredDraft`) without trusting anything in it. */
export function validateDraft(body: unknown, channelId: string): { draft: SharedDraft } | { error: string } {
  if (!isObject(body)) return { error: 'Send the draft as a JSON object.' };
  if (body.channelId !== channelId) return { error: 'The draft is for another channel.' };
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) return { error: 'The draft needs the programming version it was made from.' };
  if (typeof body.dirty !== 'boolean') return { error: '"dirty" must be true or false.' };
  if (!positions(body.current)) return { error: '"current" must be lineup positions.' };
  for (const key of ['past', 'future'] as const) {
    const entries = body[key];
    if (!Array.isArray(entries) || entries.length > MAX_HISTORY_ENTRIES) return { error: `"${key}" must be a list of edits.` };
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.label !== 'string' || entry.label.length > 500 || !positions(entry.before) || !positions(entry.after) || !block(entry.blockBefore) || !block(entry.blockAfter)) {
        return { error: `An edit in "${key}" is not valid.` };
      }
    }
  }
  if (body.extras !== undefined) {
    const problem = lineupItemsError(body.extras, 'Added item');
    if (problem) return { error: problem };
  }
  if (body.programs !== undefined && !isObject(body.programs)) return { error: '"programs" must be an object.' };
  if (body.keepOnAir !== undefined && typeof body.keepOnAir !== 'boolean') return { error: '"keepOnAir" must be true or false.' };
  const draft: SharedDraft = {
    channelId, version: body.version, updatedAt: Date.now(), dirty: body.dirty, current: body.current, past: body.past, future: body.future,
    ...(body.extras ? { extras: body.extras } : {}), ...(body.programs ? { programs: body.programs } : {}), ...(body.keepOnAir ? { keepOnAir: true } : {}),
  };
  return { draft };
}

export type SharedDraftStore = {
  list(): Promise<DraftSummary[]>;
  get(channelId: string): Promise<SharedDraft | undefined>;
  put(draft: SharedDraft): Promise<SharedDraft>;
  remove(channelId: string): Promise<void>;
};

export function createSharedDraftStore(dataDir: string): SharedDraftStore {
  const dir = path.join(dataDir, 'drafts');
  // Which channels have a draft: kept in an index file so listing doesn't read every draft.
  const index = createJsonFile(dir, 'index.json', 'shared drafts index');
  const files = new Map<string, JsonFile>();
  const fileFor = (channelId: string) => {
    if (!CHANNEL_ID.test(channelId) || channelId === 'index') throw new StoreError(400, 'invalid_parameter', 'Channel id is not valid.');
    let file = files.get(channelId);
    if (!file) {
      file = createJsonFile(dir, `${channelId}.json`, 'shared draft');
      files.set(channelId, file);
    }
    return file;
  };

  const readIndex = async (): Promise<Record<string, DraftSummary>> => {
    const data = await index.read();
    const drafts = isObject(data) && isObject(data.drafts) ? data.drafts : {};
    return Object.fromEntries(Object.entries(drafts).filter(([, value]) => isObject(value) && typeof value.version === 'string')) as Record<string, DraftSummary>;
  };

  return {
    list: () => index.serialize(async () => Object.values(await readIndex()).sort((a, b) => b.updatedAt - a.updatedAt)),
    async get(channelId) {
      const file = fileFor(channelId);
      return file.serialize(async () => {
        const data = await file.read();
        return isObject(data) && data.channelId === channelId && typeof data.version === 'string' ? (data as SharedDraft) : undefined;
      });
    },
    async put(draft) {
      const file = fileFor(draft.channelId);
      await index.serialize(async () => {
        const drafts = await readIndex();
        if (!drafts[draft.channelId] && Object.keys(drafts).length >= MAX_SHARED_DRAFTS) {
          throw new StoreError(409, 'too_many_drafts', `The companion keeps unsaved work for up to ${MAX_SHARED_DRAFTS} channels. Save or revert some first.`);
        }
        await file.serialize(() => file.write(draft));
        drafts[draft.channelId] = { channelId: draft.channelId, version: draft.version, updatedAt: draft.updatedAt, dirty: draft.dirty };
        await index.write({ version: 1, drafts });
      });
      return draft;
    },
    async remove(channelId) {
      const file = fileFor(channelId);
      await index.serialize(async () => {
        await file.serialize(() => file.remove());
        const drafts = await readIndex();
        if (!drafts[channelId]) return;
        delete drafts[channelId];
        await index.write({ version: 1, drafts });
      });
    },
  };
}
