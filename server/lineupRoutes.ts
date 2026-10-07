// Lineup's own routes (not Tunarr's): saved programming templates, filler-list
// roles, the media folder (LINEUP_MEDIA_DIR) and the AI programming assistant. They share the proxy's pipeline (method allowlist,
// Origin check, JSON bodies, optional sign-in) but answer from the companion.
import { aiFailure, buildUserMessage, callModel, gatherContext, MAX_PROMPT_CHARS, resolveProposal, SYSTEM_PROMPT, type AiConfig } from './ai.js';
import { buildFromLibrary } from './content.js';
import { validateMediaSourceAdd } from './admin.js';
import { FILLER_ROLES, folderRole, isFillerRole, ROLE_LABELS, type FillerRole } from './fillerRoles.js';
import type { FillerRoleStore } from './fillerRoleStore.js';
import { mediaFileName, ROLE_FOLDERS, type MediaFolder } from './mediaFolder.js';
import { validateTemplate } from './templateSchema.js';
import { newTemplateId, StoreError, type TemplateStore } from './templateStore.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json, UpstreamError } from './upstream.js';

export type LineupRoute =
  | { name: 'templates'; methods: string[] }
  | { name: 'template'; methods: string[]; id: string }
  | { name: 'filler-roles'; methods: string[] }
  | { name: 'filler-role'; methods: string[]; id: string }
  | { name: 'media-folder'; methods: string[] }
  | { name: 'filler-sync'; methods: string[] }
  | { name: 'filler-folders'; methods: string[] }
  | { name: 'filler-folder-add'; methods: string[] }
  | { name: 'media-file'; methods: string[]; role: FillerRole; file: string }
  | { name: 'media-file-move'; methods: string[]; role: FillerRole; file: string }
  | { name: 'ai-status'; methods: string[] }
  | { name: 'ai-template'; methods: string[] };

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function matchLineupRoute(path: string): LineupRoute | { invalid: string } | null {
  if (path === '/templates') return { name: 'templates', methods: ['GET', 'POST'] };
  if (path === '/filler-roles') return { name: 'filler-roles', methods: ['GET'] };
  const role = /^\/filler-roles\/([^/]+)$/.exec(path);
  if (role) return UUID.test(role[1]) ? { name: 'filler-role', methods: ['PUT', 'DELETE'], id: role[1] } : { invalid: 'Filler list id is not valid.' };
  if (path === '/media-folder') return { name: 'media-folder', methods: ['GET'] };
  if (path === '/filler-folders') return { name: 'filler-folders', methods: ['GET'] };
  if (path === '/filler-folders/sync') return { name: 'filler-sync', methods: ['POST'] };
  if (path === '/filler-folders/add') return { name: 'filler-folder-add', methods: ['POST'] };
  const media = /^\/media-folder\/([^/]+)\/([^/]+)(\/move)?$/.exec(path);
  if (media) {
    if (!isFillerRole(media[1])) return { invalid: 'Folder is not one of the filler roles.' };
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(media[2]);
    } catch {
      // Falls through to the error below.
    }
    const file = mediaFileName(decoded);
    if (!file) return { invalid: 'File names need a video extension (.mp4, .mkv, .mov…) and no slashes or leading dots.' };
    // Uploads (PUT) never get here: nodeAdapter.ts streams them to disk before any body is read.
    return media[3] ? { name: 'media-file-move', methods: ['POST'], role: media[1], file } : { name: 'media-file', methods: ['DELETE'], role: media[1], file };
  }
  if (path === '/ai') return { name: 'ai-status', methods: ['GET'] };
  if (path === '/ai/template') return { name: 'ai-template', methods: ['POST'] };
  const match = /^\/templates\/([^/]+)$/.exec(path);
  if (match) return TEMPLATE_ID.test(match[1]) ? { name: 'template', methods: ['PUT', 'DELETE'], id: match[1] } : { invalid: 'Template id is not valid.' };
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_SOURCE_NAME = 'Lineup media folder';
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Each role folder's library in Tunarr, found by its path (Tunarr's externalKey for local folders). */
export function roleLibraries(sources: unknown, folder: MediaFolder) {
  const found: Partial<Record<FillerRole, { mediaSourceId: string; libraryId: string; lastScannedAt?: number; scanning: boolean }>> = {};
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!isObject(source) || source.type !== 'local' || typeof source.id !== 'string') continue;
    for (const library of Array.isArray(source.libraries) ? source.libraries : []) {
      if (!isObject(library) || typeof library.id !== 'string') continue;
      const role = FILLER_ROLES.find((item) => folder.tunarrPath(item) === library.externalKey);
      if (role && !found[role]) found[role] = { mediaSourceId: source.id, libraryId: library.id, lastScannedAt: typeof library.lastScannedAt === 'number' ? library.lastScannedAt : undefined, scanning: !!library.isLocked };
    }
  }
  return found;
}

/** `target` is null when TUNARR_URL isn't set; only the AI route needs it (the proxy checks). */
export type SyncResult = {
  /** The upload folder was just added to Tunarr. */
  connected: boolean;
  created: Array<{ id: string; name: string; count: number; role: FillerRole }>;
  updated: Array<{ id: string; count: number }>;
  errors: string[];
};

const errorMessage = (error: unknown) => (error instanceof UpstreamError || error instanceof StoreError ? error.message : 'Something went wrong.');

/**
 * Picks up folders without anyone pressing a button: adds the upload folder to
 * Tunarr, refreshes every folder-built filler list whose library Tunarr has
 * scanned since the list was last read, and makes a list for each upload role
 * folder that has videos but no list yet. Runs when the desk loads and while
 * Filler Folders is open; one run at a time, so two tabs can't make a list twice.
 */
const running = new WeakMap<ProxyConfig, Promise<SyncResult>>();
// Library id → the scan time it was found empty at, so it's read again only after a new scan.
const emptyAt = new WeakMap<ProxyConfig, Map<string, number | undefined>>();
export function syncFillerFolders(config: ProxyConfig, target: TunarrTarget): Promise<SyncResult> {
  let run = running.get(config);
  if (!run) {
    run = runSync(config, target).finally(() => running.delete(config));
    running.set(config, run);
  }
  return run;
}

async function runSync(config: ProxyConfig, target: TunarrTarget): Promise<SyncResult> {
  const result: SyncResult = { connected: false, created: [], updated: [], errors: [] };
  const media = config.mediaFolder && !('off' in config.mediaFolder) ? config.mediaFolder : undefined;
  const store = config.fillerRoles as FillerRoleStore | undefined;
  let sources = await callTunarr(config, target, 'GET', '/api/media-sources');
  if (media && !Object.keys(roleLibraries(sources, media)).length) {
    try {
      await media.prepare();
      // Tunarr scans a new local source on its own.
      await callTunarr(config, target, 'POST', '/api/media-sources', JSON.stringify({ type: 'local', name: LOCAL_SOURCE_NAME, mediaType: 'other_videos', paths: FILLER_ROLES.map((role) => media.tunarrPath(role)), pathReplacements: [] }));
      result.connected = true;
      sources = await callTunarr(config, target, 'GET', '/api/media-sources');
    } catch (error) {
      result.errors.push(`The upload folder couldn’t be added to Tunarr: ${errorMessage(error)}`);
    }
  }
  if (!store) return result;

  type Library = { id: string; mediaSourceId: string; name: string; enabled: boolean; lastScannedAt?: number; scanning: boolean };
  const libraries: Library[] = [];
  for (const source of Array.isArray(sources) ? sources.filter(isObject) : []) {
    for (const library of Array.isArray(source.libraries) ? source.libraries.filter(isObject) : []) {
      if (typeof source.id !== 'string' || typeof library.id !== 'string') continue;
      libraries.push({ id: library.id, mediaSourceId: source.id, name: typeof library.name === 'string' ? library.name : '', enabled: library.enabled !== false, lastScannedAt: typeof library.lastScannedAt === 'number' ? library.lastScannedAt : undefined, scanning: !!library.isLocked });
    }
  }
  const byId = new Map(libraries.map((library) => [library.id, library]));

  // 1. Lists already built from a folder: re-read after a finished scan newer than the list.
  const { links } = await store.folders();
  for (const [listId, link] of Object.entries(links)) {
    const library = byId.get(link.libraryId);
    if (!library || library.scanning || !library.lastScannedAt || library.lastScannedAt <= (link.builtAt ?? 0)) continue;
    try {
      const built = await buildFromLibrary(config, target, { mediaSourceId: link.mediaSourceId, libraryId: link.libraryId, listId });
      if (built) result.updated.push({ id: listId, count: built.count });
    } catch (error) {
      // The list was deleted in Tunarr: stop following it, and don't make it again.
      if (error instanceof UpstreamError && error.status === 404) await store.unlink(listId, true).catch(() => undefined);
      else result.errors.push(errorMessage(error));
    }
  }

  // 2. Folders with no list yet: the upload folder's role folders, folders added
  //    with a role, and any library plainly named for a role ("Commercials").
  const { links: current, pending, ignored } = await store.folders();
  const skip = new Set([...Object.values(current).map((link) => link.libraryId), ...ignored]);
  const uploads = media ? roleLibraries(sources, media) : {};
  const uploadRole = new Map(Object.entries(uploads).map(([role, library]) => [library!.libraryId, role as FillerRole]));
  if (!emptyAt.has(config)) emptyAt.set(config, new Map());
  const empty = emptyAt.get(config)!;
  for (const library of libraries) {
    if (skip.has(library.id) || !library.enabled || library.scanning) continue;
    if (empty.has(library.id) && empty.get(library.id) === library.lastScannedAt) continue;
    const upload = uploadRole.get(library.id);
    const waiting = pending[library.id];
    const role = upload ?? waiting?.role ?? folderRole(library.name);
    if (!role) continue;
    const name = upload ? `${ROLE_LABELS[role]} (folder)` : waiting?.name ?? `${ROLE_LABELS[role]} – ${lastSegment(library.name)}`;
    try {
      const built = await buildFromLibrary(config, target, { mediaSourceId: library.mediaSourceId, libraryId: library.id, name, role });
      if (built) result.created.push({ id: built.id, name, count: built.count, role });
      else empty.set(library.id, library.lastScannedAt);
    } catch (error) {
      result.errors.push(errorMessage(error));
    }
  }
  return result;
}

type Context = { config: ProxyConfig; target: TunarrTarget | null; method: string; body: unknown };

export async function handleLineupRoute(route: LineupRoute, { config, target, method, body }: Context): Promise<ProxyResponse> {
  const store = config.templates as TemplateStore | undefined;
  const roles = config.fillerRoles as FillerRoleStore | undefined;
  const media = config.mediaFolder && !('off' in config.mediaFolder) ? config.mediaFolder : undefined;
  const mediaOff = () => fail(503, 'media_folder_off', config.mediaFolder && 'off' in config.mediaFolder ? config.mediaFolder.off : 'The media folder is off. Set LINEUP_MEDIA_DIR on the Lineup server to upload files.');
  try {
    switch (route.name) {
      case 'media-folder': {
        if (!media) return json(200, { enabled: false, message: config.mediaFolder && 'off' in config.mediaFolder ? config.mediaFolder.off : 'Set LINEUP_MEDIA_DIR on the Lineup server to upload files here.' });
        const files = await media.list();
        // Which folders Tunarr already reads. Optional: the files still show without Tunarr.
        let libraries: ReturnType<typeof roleLibraries> = {};
        let tunarrError: string | undefined;
        if (target) {
          try {
            libraries = roleLibraries(await callTunarr(config, target, 'GET', '/api/media-sources'), media);
          } catch (error) {
            tunarrError = error instanceof UpstreamError ? error.message : 'Tunarr could not be reached.';
          }
        } else tunarrError = 'TUNARR_URL is not set on the Lineup server.';
        return json(200, {
          enabled: true,
          maxBytes: media.maxBytes,
          folders: FILLER_ROLES.map((role) => ({ role, folder: ROLE_FOLDERS[role], files: files[role], tunarr: libraries[role] ?? null })),
          ...(tunarrError ? { tunarrError } : {}),
        });
      }
      case 'filler-sync':
        return json(200, await syncFillerFolders(config, target!));
      case 'filler-folders': {
        if (!roles) return json(200, { links: {}, pending: {}, ignored: [] });
        return json(200, await roles.folders());
      }
      case 'filler-folder-add': {
        if (!roles) return fail(503, 'store_off', 'Filler roles are not available on this server.');
        const role = isObject(body) ? body.role : undefined;
        if (!isFillerRole(role)) return fail(400, 'invalid_request', 'Choose the folder’s role.');
        const path = isObject(body) && typeof body.path === 'string' ? body.path.trim() : '';
        const name = `${ROLE_LABELS[role]} – ${lastSegment(path)}`;
        const checked = validateMediaSourceAdd({ type: 'local', name, mediaType: 'other_videos', paths: [path] });
        if ('error' in checked) return fail(400, 'invalid_request', checked.error);
        if (checked.kind !== 'insert') return fail(400, 'invalid_request', 'Enter a folder on the Tunarr server.');
        const created = (await callTunarr(config, target!, 'POST', '/api/media-sources', JSON.stringify(checked.body))) as Json | null;
        const sources = await callTunarr(config, target!, 'GET', '/api/media-sources');
        const source = (Array.isArray(sources) ? sources : []).find((item) => isObject(item) && item.id === created?.id) as Json | undefined;
        const library = (Array.isArray(source?.libraries) ? source!.libraries : []).find(isObject) as Json | undefined;
        if (typeof created?.id !== 'string' || typeof library?.id !== 'string') return fail(502, 'tunarr_invalid_response', 'Tunarr added the folder but didn’t list it. Make its list from Filler Folders once it appears.');
        // Its list is made by the next sync after Tunarr's first scan.
        await roles.addPending(library.id, { mediaSourceId: created.id, role, name });
        return json(201, { mediaSourceId: created.id, libraryId: library.id, name });
      }
      case 'media-file': {
        if (!media) return mediaOff();
        await media.remove(route.role, route.file);
        return json(200, { deleted: true });
      }
      case 'media-file-move': {
        if (!media) return mediaOff();
        const to = isObject(body) ? body.role : undefined;
        if (!isFillerRole(to)) return fail(400, 'invalid_request', 'Send { "role" } with the folder to move the file to.');
        await media.move(route.role, route.file, to);
        return json(200, { moved: true, role: to });
      }
      case 'filler-roles': {
        if (!roles) return fail(503, 'store_off', 'Filler roles are not available on this server.');
        return json(200, await roles.list());
      }
      case 'filler-role': {
        if (!roles) return fail(503, 'store_off', 'Filler roles are not available on this server.');
        if (method === 'DELETE') return json(200, await roles.remove(route.id));
        const role = isObject(body) ? body.role : undefined;
        if (!isFillerRole(role)) return fail(400, 'invalid_request', 'Send { "role" } with station-id, commercials, promos, bumpers or other.');
        return json(200, await roles.set(route.id, role));
      }
      case 'templates': {
        if (!store) return fail(503, 'store_off', 'Saving templates is not available on this server.');
        if (method === 'GET') return json(200, await store.list());
        const checked = validateTemplate({ ...(isObject(body) ? body : {}), id: newTemplateId() });
        if ('error' in checked) return fail(400, 'invalid_template', checked.error);
        return json(201, await store.save(checked.template));
      }
      case 'template': {
        if (!store) return fail(503, 'store_off', 'Saving templates is not available on this server.');
        if (method === 'DELETE') {
          return (await store.remove(route.id)) ? json(200, { deleted: true }) : fail(404, 'not_found', 'That template is not saved.');
        }
        const checked = validateTemplate({ ...(isObject(body) ? body : {}), id: route.id });
        if ('error' in checked) return fail(400, 'invalid_template', checked.error);
        return json(200, await store.save(checked.template));
      }
      case 'ai-status': {
        const ai = config.ai;
        if (!ai || 'off' in ai) return json(200, { enabled: false, message: ai && 'off' in ai ? ai.off : 'AI is not set up on this server.' });
        return json(200, { enabled: true, provider: ai.provider, model: ai.model });
      }
      case 'ai-template': {
        const ai = config.ai;
        if (!target) return fail(503, 'not_configured', 'TUNARR_URL is not set on the Lineup server.');
        if (!ai || 'off' in ai) return fail(503, 'ai_off', ai && 'off' in ai ? ai.off : 'AI is not set up on this server.');
        if (!isObject(body)) return fail(400, 'invalid_request', 'Send { "prompt", "channelId"?, "includeLibrary"?, "baseTemplate"? }.');
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt || prompt.length > MAX_PROMPT_CHARS) return fail(400, 'invalid_request', `Write a prompt (up to ${MAX_PROMPT_CHARS} characters).`);
        if (body.channelId !== undefined && (typeof body.channelId !== 'string' || !CHANNEL_ID.test(body.channelId))) return fail(400, 'invalid_request', 'Channel id is not valid.');
        let base: unknown;
        if (body.baseTemplate !== undefined) {
          const checked = validateTemplate(body.baseTemplate);
          if ('error' in checked) return fail(400, 'invalid_request', `Base template: ${checked.error}`);
          // The model gets the plan only, not saved sources or bookkeeping.
          const plan: Partial<typeof checked.template> = { ...checked.template };
          delete plan.defaults;
          delete plan.custom;
          delete plan.updatedAt;
          base = plan;
        }
        const context = await gatherContext(config, target, { channelId: body.channelId as string | undefined, library: body.includeLibrary !== false });
        const raw = await callModel(ai as AiConfig, SYSTEM_PROMPT, buildUserMessage(prompt, context, base));
        const proposal = resolveProposal(raw, context, newTemplateId('ai'));
        if ('error' in proposal) return fail(502, 'ai_invalid', proposal.error);
        return json(200, proposal);
      }
    }
  } catch (error) {
    if (error instanceof StoreError) return fail(error.status, error.code, error.message);
    if (error instanceof UpstreamError) throw error;
    const failure = aiFailure(error);
    return fail(failure.status, failure.code, failure.message);
  }
}
