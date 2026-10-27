// Local videos (owner decision 2026-10-27, D70): music videos and downloaded
// videos that aren't in Plex or another media server. They live in folders
// Tunarr reads as local sources: named folders under music-videos/ and
// videos/ in Lineup's media folder (uploaded from the desk), or folders already
// on the Tunarr server. Each folder is one Tunarr library, and a followed
// folder keeps a custom show of its videos up to date after each scan, the way
// filler folders keep their lists (D46). Programs still come only from what
// Tunarr has indexed (invariant 3).
import { compatibility, cachedCompatibility, unavailableReason, type CapabilityId, type PartId } from './compatibility.js';
import { readLibrary } from './content.js';
import { FILLER_ROLES } from './fillerRoles.js';
import type { FillerRoleStore } from './fillerRoleStore.js';
import { StoreError } from './jsonFile.js';
import type { LocalVideoState, LocalVideoStore } from './localVideoStore.js';
import type { MediaFile, MediaFolder } from './mediaFolder.js';
import type { ProxyConfig, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, UpstreamError } from './upstream.js';
import { folderOrder, VIDEO_KIND_LABELS, VIDEO_KINDS, type VideoKind } from './videoTitles.js';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const SHOW_NOT_FOUND = 'Tunarr could not find that custom show.';

export type TunarrLibrary = { mediaSourceId: string; libraryId: string; name: string; source: string; path?: string; mediaType?: string; enabled: boolean; lastScannedAt?: number; scanning: boolean };

/** Every library of Tunarr's local sources (folders on the Tunarr server). */
export function localLibraries(sources: unknown): TunarrLibrary[] {
  const found: TunarrLibrary[] = [];
  for (const source of Array.isArray(sources) ? sources.filter(isObject) : []) {
    if (source.type !== 'local' || typeof source.id !== 'string') continue;
    for (const library of Array.isArray(source.libraries) ? source.libraries.filter(isObject) : []) {
      if (typeof library.id !== 'string') continue;
      found.push({
        mediaSourceId: source.id,
        libraryId: library.id,
        name: str(library.name) ?? 'Folder',
        source: str(source.name) ?? 'Local folders',
        path: str(library.externalKey),
        mediaType: str(library.mediaType) ?? str(source.mediaType),
        enabled: library.enabled !== false,
        lastScannedAt: typeof library.lastScannedAt === 'number' ? library.lastScannedAt : undefined,
        scanning: !!library.isLocked,
      });
    }
  }
  return found;
}

/** Whether a library path is one of the media folder's program folders (music-videos/…, videos/…). */
export function isProgramPath(media: MediaFolder | undefined, path: string | undefined) {
  if (!media || !path) return false;
  return VIDEO_KINDS.some((kind) => {
    const parent = media.programs.tunarrPath(kind, '').replace(/[\\/]+$/, '');
    const rest = path.slice(parent.length);
    // Exactly one folder below music-videos/ or videos/.
    return path.startsWith(parent) && /^[\\/][^\\/]+[\\/]?$/.test(rest);
  });
}

export type LocalVideoFolderView = {
  /** `upload:<kind>/<folder>` for the media folder's own, `library:<id>` for a folder on the Tunarr server. */
  key: string;
  kind: VideoKind;
  name: string;
  /** The media folder's own folders: where they are (`area`: music-videos/ or videos/) and their files (uploads, deletes, previews go there). */
  upload?: { area: VideoKind; folder: string; files: MediaFile[] };
  /** Its Tunarr library, or null until Tunarr has added it. Never its path (nor its name: Tunarr names local libraries after their path). */
  tunarr: Omit<TunarrLibrary, 'path' | 'mediaType' | 'name'> | null;
  /** The custom show that follows it. */
  show: { id: string; builtAt?: number } | null;
  /** Its show is made after Tunarr's next scan. */
  pending: boolean;
};

const mediaOf = (config: ProxyConfig) => (config.mediaFolder && !('off' in config.mediaFolder) ? config.mediaFolder : undefined);
const storeOf = (config: ProxyConfig) => config.localVideos as LocalVideoStore | undefined;

/**
 * The folders the Local Videos dialog lists: the media folder's program
 * folders, and the Tunarr server's local libraries that hold loose videos
 * (marked as local videos, or music- and other-video libraries) other than
 * filler folders.
 */
export async function localVideoFolders(config: ProxyConfig, sources: unknown | null, state: LocalVideoState): Promise<LocalVideoFolderView[]> {
  const media = mediaOf(config);
  const libraries = sources === null ? [] : localLibraries(sources);
  const byPath = new Map(libraries.filter((library) => library.path).map((library) => [library.path!, library]));
  const fillerLinks = config.fillerRoles ? Object.values((await (config.fillerRoles as FillerRoleStore).folders().catch(() => ({ links: {} }))).links).map((link) => link.libraryId) : [];
  const roleFolders = new Set(media ? FILLER_ROLES.map((role) => media.tunarrPath(role)) : []);
  const showFor = (libraryId: string) => {
    const entry = Object.entries(state.shows).find(([, link]) => link.libraryId === libraryId);
    return entry ? { id: entry[0], ...(entry[1].builtAt ? { builtAt: entry[1].builtAt } : {}) } : null;
  };
  const view = (library: TunarrLibrary | undefined) => (library ? { mediaSourceId: library.mediaSourceId, libraryId: library.libraryId, source: library.source, enabled: library.enabled, lastScannedAt: library.lastScannedAt, scanning: library.scanning } : null);
  const out: LocalVideoFolderView[] = [];
  const claimed = new Set<string>();
  for (const folder of media ? await media.programs.list() : []) {
    const library = byPath.get(media!.programs.tunarrPath(folder.kind, folder.folder));
    if (library) claimed.add(library.libraryId);
    out.push({
      key: `upload:${folder.kind}/${folder.folder}`,
      kind: (library && state.kinds[library.libraryId]) || folder.kind,
      name: folder.folder,
      upload: { area: folder.kind, folder: folder.folder, files: folder.files },
      tunarr: view(library),
      show: library ? showFor(library.libraryId) : null,
      pending: !!library && library.libraryId in state.pending,
    });
  }
  for (const library of libraries) {
    if (claimed.has(library.libraryId) || fillerLinks.includes(library.libraryId) || (library.path && roleFolders.has(library.path))) continue;
    const kind = state.kinds[library.libraryId] ?? (library.mediaType === 'music_videos' ? 'music-videos' : library.mediaType === 'other_videos' ? 'videos' : undefined);
    if (!kind) continue;
    out.push({ key: `library:${library.libraryId}`, kind, name: lastSegment(library.path ?? library.name), tunarr: view(library), show: showFor(library.libraryId), pending: library.libraryId in state.pending });
  }
  return out;
}

export type ShowRequest = { mediaSourceId: string; libraryId: string; kind: VideoKind; showId?: string; name?: string };

/**
 * Creates (name) or refreshes (showId) a custom show from everything Tunarr
 * indexed in one folder, in folder order (file names; music videos by artist),
 * then records that it follows the folder. Null when the folder has nothing
 * playable yet (Tunarr refuses empty shows).
 */
export async function buildShowFromFolder(config: ProxyConfig, target: TunarrTarget, request: ShowRequest): Promise<{ id: string; count: number; storeError?: string } | null> {
  const report = cachedCompatibility(config);
  const refused = unavailableReason(report, 'library-search') ?? unavailableReason(report, 'custom-shows', request.showId ? 'edit' : 'create');
  if (refused) throw new UpstreamError(501, 'tunarr_unsupported', refused);
  const found = await readLibrary(config, target, request.mediaSourceId, request.libraryId);
  if (!found.length) return null;
  const programs = folderOrder(found.map((entry) => ({ entry, title: (entry.program as Json | undefined)?.title })), request.kind)
    .map(({ entry }) => ({ type: 'content', id: entry.id, duration: entry.duration }));
  const call = (verb: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown, notFound?: string) => callTunarr(config, target, verb, path, payload === undefined ? undefined : JSON.stringify(payload), notFound);
  let id = request.showId;
  if (id) {
    // Tunarr clears playlist sync unless the update re-states it, so keep whatever the show has.
    const current = (await call('GET', `/api/custom-shows/${id}`, undefined, SHOW_NOT_FOUND)) as Json | null;
    await call('PUT', `/api/custom-shows/${id}`, {
      programs,
      enableSync: !!current?.syncMediaSourceId,
      syncMediaSourceId: current?.syncMediaSourceId ?? null,
      syncMediaSourceType: current?.syncMediaSourceType ?? null,
      syncExternalPlaylistId: current?.syncExternalPlaylistId ?? null,
    }, SHOW_NOT_FOUND);
  } else {
    id = str(((await call('POST', '/api/custom-shows', { name: request.name, programs, syncMediaSourceId: null, syncMediaSourceType: null, syncExternalPlaylistId: null })) as Json | null)?.id);
  }
  if (!id) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr did not return the new custom show.');
  // The show exists in Tunarr either way; a store failure is reported, not hidden.
  let storeError: string | undefined;
  try {
    await storeOf(config)?.follow(id, { mediaSourceId: request.mediaSourceId, libraryId: request.libraryId, kind: request.kind, builtAt: Date.now() });
  } catch (error) {
    storeError = error instanceof StoreError ? error.message : 'Lineup couldn’t remember that the show follows its folder.';
  }
  return { id, count: programs.length, ...(storeError ? { storeError } : {}) };
}

/** A show's name from its folder: "Music videos – 80s Rock". */
export const showName = (kind: VideoKind, folder: string) => `${VIDEO_KIND_LABELS[kind]} – ${folder}`.slice(0, 200);

/**
 * Adds one folder to Tunarr as a local source of other videos, and returns its
 * library. Other videos, because Tunarr reads loose files there by file name;
 * a music-video library expects artist folders. Lineup reads artists from the
 * file names itself.
 */
export async function addFolderToTunarr(config: ProxyConfig, target: TunarrTarget, name: string, path: string): Promise<{ mediaSourceId: string; libraryId: string }> {
  const created = (await callTunarr(config, target, 'POST', '/api/media-sources', JSON.stringify({ type: 'local', name: name.slice(0, 200), mediaType: 'other_videos', paths: [path], pathReplacements: [] }))) as Json | null;
  const sources = await callTunarr(config, target, 'GET', '/api/media-sources');
  const library = localLibraries(sources).find((item) => item.mediaSourceId === created?.id);
  if (typeof created?.id !== 'string' || !library) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr added the folder but didn’t list it. It appears in Local Videos once Tunarr has scanned it.');
  return { mediaSourceId: created.id, libraryId: library.libraryId };
}

export type LocalVideoSync = {
  /** Media-folder folders just added to Tunarr. */
  connected: string[];
  created: Array<{ id: string; name: string; count: number }>;
  updated: Array<{ id: string; count: number }>;
  errors: string[];
  /** Steps left out because the compatibility check shows this Tunarr lacks their route (each reason once). */
  skipped: string[];
};

const errorMessage = (error: unknown) => (error instanceof UpstreamError || error instanceof StoreError ? error.message : 'Something went wrong.');

/**
 * Picks up local videos without anyone pressing a button: adds new media-folder
 * folders to Tunarr (their shows follow once scanned), refreshes every followed
 * show whose folder Tunarr has scanned since, and makes the shows folders are
 * waiting for. One run per server at a time, so two tabs can't make a show twice.
 */
const running = new WeakMap<ProxyConfig, Promise<LocalVideoSync>>();
// Library id → the scan it was found empty at, so it's read again only after a new scan.
const emptyAt = new WeakMap<ProxyConfig, Map<string, number | undefined>>();
export function syncLocalVideos(config: ProxyConfig, target: TunarrTarget): Promise<LocalVideoSync> {
  let run = running.get(config);
  if (!run) {
    run = runSync(config, target).finally(() => running.delete(config));
    running.set(config, run);
  }
  return run;
}

async function runSync(config: ProxyConfig, target: TunarrTarget): Promise<LocalVideoSync> {
  const result: LocalVideoSync = { connected: [], created: [], updated: [], errors: [], skipped: [] };
  const media = mediaOf(config);
  const store = storeOf(config);
  if (!store) return result;
  // Like the filler pickup: each step is left out on its own when this Tunarr lacks its route.
  const report = await compatibility(config).catch(() => undefined);
  const off = (id: CapabilityId, part?: PartId) => unavailableReason(report, id, part);
  const leaveOut = (what: string, reason: string) => {
    const line = `${what}: ${reason}`;
    if (!result.skipped.includes(line)) result.skipped.push(line);
  };
  const sourcesOff = off('media-sources');
  if (sourcesOff) {
    leaveOut('Local videos aren’t picked up', sourcesOff);
    return result;
  }
  const readOff = off('library-search');
  const createOff = readOff ?? off('custom-shows', 'create');
  const editOff = readOff ?? off('custom-shows', 'edit');
  let libraries = localLibraries(await callTunarr(config, target, 'GET', '/api/media-sources'));

  // 1. Media-folder folders Tunarr doesn't read yet (made while it was away, or in a file manager): add each, and follow it.
  if (media) {
    const known = new Set(libraries.map((library) => library.path));
    const missing = (await media.programs.folders().catch((error) => { result.errors.push(errorMessage(error)); return []; }))
      .filter((folder) => !known.has(media.programs.tunarrPath(folder.kind, folder.folder)));
    const connectOff = off('media-sources', 'create');
    if (missing.length && connectOff) leaveOut('New folders weren’t added to Tunarr', connectOff);
    else {
      for (const folder of missing) {
        try {
          const added = await addFolderToTunarr(config, target, showName(folder.kind, folder.folder), media.programs.tunarrPath(folder.kind, folder.folder));
          await store.setKind(added.libraryId, folder.kind);
          await store.addPending(added.libraryId, { mediaSourceId: added.mediaSourceId, name: showName(folder.kind, folder.folder), kind: folder.kind });
          result.connected.push(folder.folder);
        } catch (error) {
          result.errors.push(`${folder.folder} couldn’t be added to Tunarr: ${errorMessage(error)}`);
        }
      }
      if (result.connected.length) libraries = localLibraries(await callTunarr(config, target, 'GET', '/api/media-sources'));
    }
  }
  const byId = new Map(libraries.map((library) => [library.libraryId, library]));
  const scanned = (library: TunarrLibrary | undefined) => !!library && !library.scanning && !!library.lastScannedAt;

  // 2. Followed shows: read their folder again after a finished scan newer than the show.
  const state = await store.state();
  for (const [showId, link] of Object.entries(state.shows)) {
    const library = byId.get(link.libraryId);
    if (!scanned(library) || library!.lastScannedAt! <= (link.builtAt ?? 0)) continue;
    if (editOff) {
      leaveOut('Shows weren’t updated from their folders', editOff);
      continue;
    }
    try {
      const built = await buildShowFromFolder(config, target, { mediaSourceId: link.mediaSourceId, libraryId: link.libraryId, kind: state.kinds[link.libraryId] ?? link.kind, showId });
      if (built) result.updated.push({ id: showId, count: built.count });
    } catch (error) {
      // The show was deleted in Tunarr: stop following its folder (it isn't made again).
      if (error instanceof UpstreamError && error.status === 404) await store.unfollow(showId).catch(() => undefined);
      else result.errors.push(errorMessage(error));
    }
  }

  // 3. Folders waiting for their first scan.
  if (!emptyAt.has(config)) emptyAt.set(config, new Map());
  const empty = emptyAt.get(config)!;
  for (const [libraryId, pending] of Object.entries(state.pending)) {
    const library = byId.get(libraryId);
    if (!scanned(library) || !library!.enabled) continue;
    if (empty.has(libraryId) && empty.get(libraryId) === library!.lastScannedAt) continue;
    if (createOff) {
      leaveOut('Folders didn’t get their custom shows', createOff);
      continue;
    }
    try {
      const built = await buildShowFromFolder(config, target, { mediaSourceId: library!.mediaSourceId, libraryId, kind: state.kinds[libraryId] ?? pending.kind, name: pending.name });
      if (built) result.created.push({ id: built.id, name: pending.name, count: built.count });
      else empty.set(libraryId, library!.lastScannedAt);
    } catch (error) {
      result.errors.push(errorMessage(error));
    }
  }
  return result;
}
