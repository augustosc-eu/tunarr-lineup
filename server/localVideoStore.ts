// Local videos (music videos, downloads) as Lineup keeps track of them, in
// LINEUP_DATA_DIR/local-videos.json (owner decision 2026-10-27, D70): what each
// Tunarr library of loose files holds (music videos or other videos), which
// custom show follows which folder, and folders waiting for Tunarr's first scan
// before their show is made. Tunarr has no field for any of this, and putting
// it in names would rename the user's data in Tunarr.
import { createJsonFile, StoreError } from './jsonFile.js';
import { isVideoKind, type VideoKind } from './videoTitles.js';

export const MAX_LOCAL_VIDEO_ENTRIES = 1000;
const FILE = 'local-videos.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A custom show that follows a folder: its programs are replaced after each newer Tunarr scan. */
export type ShowLink = { mediaSourceId: string; libraryId: string; kind: VideoKind; builtAt?: number };
/** A folder whose show is made once Tunarr has scanned it. */
export type PendingShow = { mediaSourceId: string; name: string; kind: VideoKind };
export type LocalVideoState = {
  kinds: Record<string, VideoKind>;
  shows: Record<string, ShowLink>;
  pending: Record<string, PendingShow>;
};

export type LocalVideoStore = {
  readonly location: string;
  state(): Promise<LocalVideoState>;
  /** What a library holds; null forgets it (it stops being a local-video folder). */
  setKind(libraryId: string, kind: VideoKind | null): Promise<LocalVideoState>;
  /** The show follows this library from now on (and stops waiting for it). A library feeds one show. */
  follow(showId: string, link: ShowLink): Promise<LocalVideoState>;
  /** Stops following: the show itself stays in Tunarr. */
  unfollow(showId: string): Promise<LocalVideoState>;
  /** Stops following a library: its show link and any wait for its first scan. */
  unfollowLibrary(libraryId: string): Promise<LocalVideoState>;
  addPending(libraryId: string, pending: PendingShow): Promise<LocalVideoState>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const empty = (): LocalVideoState => ({ kinds: {}, shows: {}, pending: {} });

/** Drops anything a hand edit broke rather than failing the whole dialog. */
export function readLocalVideoState(data: unknown): LocalVideoState {
  const out = empty();
  if (!isRecord(data)) return out;
  if (isRecord(data.kinds)) for (const [id, kind] of Object.entries(data.kinds)) if (UUID.test(id) && isVideoKind(kind)) out.kinds[id] = kind;
  if (isRecord(data.shows)) {
    for (const [id, link] of Object.entries(data.shows)) {
      if (UUID.test(id) && isRecord(link) && UUID.test(String(link.mediaSourceId)) && UUID.test(String(link.libraryId)) && isVideoKind(link.kind)) {
        out.shows[id] = { mediaSourceId: link.mediaSourceId as string, libraryId: link.libraryId as string, kind: link.kind, ...(Number.isFinite(link.builtAt) ? { builtAt: link.builtAt as number } : {}) };
      }
    }
  }
  if (isRecord(data.pending)) {
    for (const [id, folder] of Object.entries(data.pending)) {
      if (UUID.test(id) && isRecord(folder) && UUID.test(String(folder.mediaSourceId)) && validName(folder.name) && isVideoKind(folder.kind)) {
        out.pending[id] = { mediaSourceId: folder.mediaSourceId as string, name: folder.name.trim(), kind: folder.kind };
      }
    }
  }
  return out;
}

export function createLocalVideoStore(dir: string): LocalVideoStore {
  const file = createJsonFile(dir, FILE, 'local videos');
  const read = async () => readLocalVideoState(await file.read());
  const write = async (data: LocalVideoState) => {
    await file.write({ version: 1, ...data });
    return data;
  };
  const size = (data: LocalVideoState) => Object.keys(data.kinds).length + Object.keys(data.shows).length + Object.keys(data.pending).length;
  const roomFor = (data: LocalVideoState, adding: boolean) => {
    if (adding && size(data) >= MAX_LOCAL_VIDEO_ENTRIES) throw new StoreError(409, 'too_many_folders', `Lineup can keep track of up to ${MAX_LOCAL_VIDEO_ENTRIES} local-video folders and shows.`);
  };

  return {
    location: file.location,
    state: () => file.serialize(read),
    setKind: (libraryId, kind) => file.serialize(async () => {
      const data = await read();
      if (!kind) {
        if (!(libraryId in data.kinds)) return data;
        delete data.kinds[libraryId];
        return write(data);
      }
      roomFor(data, !(libraryId in data.kinds));
      data.kinds[libraryId] = kind;
      return write(data);
    }),
    follow: (showId, link) => file.serialize(async () => {
      const data = await read();
      roomFor(data, !(showId in data.shows));
      for (const [id, existing] of Object.entries(data.shows)) if (existing.libraryId === link.libraryId) delete data.shows[id];
      data.shows[showId] = { mediaSourceId: link.mediaSourceId, libraryId: link.libraryId, kind: link.kind, ...(Number.isFinite(link.builtAt) ? { builtAt: link.builtAt } : {}) };
      delete data.pending[link.libraryId];
      return write(data);
    }),
    unfollow: (showId) => file.serialize(async () => {
      const data = await read();
      if (!(showId in data.shows)) return data;
      delete data.shows[showId];
      return write(data);
    }),
    unfollowLibrary: (libraryId) => file.serialize(async () => {
      const data = await read();
      const before = size(data);
      for (const [id, link] of Object.entries(data.shows)) if (link.libraryId === libraryId) delete data.shows[id];
      delete data.pending[libraryId];
      return size(data) === before ? data : write(data);
    }),
    addPending: (libraryId, pending) => file.serialize(async () => {
      const data = await read();
      roomFor(data, !(libraryId in data.pending));
      data.pending[libraryId] = { mediaSourceId: pending.mediaSourceId, name: pending.name.trim(), kind: pending.kind };
      return write(data);
    }),
  };
}
