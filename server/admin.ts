// Routes for setting up Tunarr itself from Lineup: creating and deleting
// channels, transcode profiles, media sources (Plex, Jellyfin, Emby, local
// folders) and smart collections. Same rules as the rest of the proxy: every
// route is explicit, ids are validated, request bodies are rebuilt from an
// allowlist, and media-server addresses and tokens are write-only (they go to
// Tunarr but are never sent back to the browser).
import { describeRules, filterToRules, rulesToFilter } from './smartCollection.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json, UpstreamError } from './upstream.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 200;

export type AdminRoute =
  | { name: 'channel-create'; methods: string[] }
  | { name: 'channel'; methods: string[]; channelId: string }
  | { name: 'transcode-configs'; methods: string[] }
  | { name: 'transcode-config'; methods: string[]; id: string }
  | { name: 'transcode-config-copy'; methods: string[]; id: string }
  | { name: 'media-sources-manage'; methods: string[] }
  | { name: 'media-source-add'; methods: string[] }
  | { name: 'media-source'; methods: string[]; id: string }
  | { name: 'media-source-refresh'; methods: string[]; id: string }
  | { name: 'media-library'; methods: string[]; id: string; libraryId: string }
  | { name: 'media-library-scan'; methods: string[]; id: string; libraryId: string }
  | { name: 'smart-collection-create'; methods: string[] }
  | { name: 'smart-collection-preview'; methods: string[] }
  | { name: 'smart-collection'; methods: string[]; id: string };

/** Matches a path below /api/tunarr. Raw (still encoded) segments are validated. */
export function matchAdminRoute(path: string, channelIdPattern: RegExp): AdminRoute | { invalid: string } | null {
  if (path === '/channels/create') return { name: 'channel-create', methods: ['POST'] };
  if (path === '/transcode-configs') return { name: 'transcode-configs', methods: ['GET'] };
  if (path === '/media-sources/manage') return { name: 'media-sources-manage', methods: ['GET'] };
  if (path === '/media-sources/add') return { name: 'media-source-add', methods: ['POST'] };
  if (path === '/smart-collections/create') return { name: 'smart-collection-create', methods: ['POST'] };
  if (path === '/smart-collections/preview') return { name: 'smart-collection-preview', methods: ['POST'] };
  let match = /^\/channels\/([^/]+)$/.exec(path);
  if (match) return channelIdPattern.test(match[1]) && match[1] !== 'create' ? { name: 'channel', methods: ['DELETE'], channelId: match[1] } : { invalid: 'Channel id is not valid.' };
  match = /^\/transcode-configs\/([^/]+)(\/copy)?$/.exec(path);
  if (match) {
    if (!UUID.test(match[1])) return { invalid: 'Profile id is not valid.' };
    return match[2] ? { name: 'transcode-config-copy', methods: ['POST'], id: match[1] } : { name: 'transcode-config', methods: ['PUT', 'DELETE'], id: match[1] };
  }
  match = /^\/media-sources\/([^/]+)(?:\/(refresh)|\/libraries\/([^/]+)(\/scan)?)?$/.exec(path);
  if (match) {
    if (!UUID.test(match[1])) return { invalid: 'Media source id is not valid.' };
    if (match[2]) return { name: 'media-source-refresh', methods: ['POST'], id: match[1] };
    if (match[3] !== undefined) {
      if (!UUID.test(match[3])) return { invalid: 'Library id is not valid.' };
      return match[4] ? { name: 'media-library-scan', methods: ['POST'], id: match[1], libraryId: match[3] } : { name: 'media-library', methods: ['PUT'], id: match[1], libraryId: match[3] };
    }
    return { name: 'media-source', methods: ['DELETE'], id: match[1] };
  }
  match = /^\/smart-collections\/([^/]+)$/.exec(path);
  if (match) return UUID.test(match[1]) ? { name: 'smart-collection', methods: ['GET', 'PUT', 'DELETE'], id: match[1] } : { invalid: 'Smart collection id is not valid.' };
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
const validName = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME;

// ----------------------------------------------------------------- channels

/** Tunarr's own defaults for a new channel (web/src/helpers/constants.ts). */
export function newChannel(name: string, number: number, transcodeConfigId: string, groupTitle: string, now = Date.now()) {
  return {
    id: crypto.randomUUID(),
    name,
    number,
    groupTitle,
    startTime: Math.floor(now / 60_000) * 60_000,
    transcodeConfigId,
    duration: 0,
    icon: { duration: 0, path: '', position: 'bottom-right', width: 0 },
    guideMinimumDuration: 30_000,
    fillerRepeatCooldown: 30_000,
    stealth: false,
    disableFillerOverlay: false,
    offline: { mode: 'pic', picture: '', soundtrack: '' },
    onDemand: { enabled: false },
    streamMode: 'hls',
    subtitlesEnabled: false,
  };
}

export function validateChannelCreate(body: unknown): { name: string; number?: number; groupTitle: string; transcodeConfigId?: string; copyFrom?: string } | { error: string } {
  if (!isObject(body)) return { error: 'Send the channel as a JSON object.' };
  if (!validName(body.name)) return { error: 'The channel needs a name (up to 200 characters).' };
  if (body.number !== undefined && (!Number.isInteger(body.number) || (body.number as number) < 1 || (body.number as number) > 99_999)) return { error: 'Channel number must be a whole number from 1.' };
  if (body.groupTitle !== undefined && (typeof body.groupTitle !== 'string' || body.groupTitle.length > MAX_NAME)) return { error: 'Group must be text.' };
  if (body.transcodeConfigId !== undefined && (typeof body.transcodeConfigId !== 'string' || !UUID.test(body.transcodeConfigId))) return { error: 'Choose a transcode profile.' };
  if (body.copyFrom !== undefined && (typeof body.copyFrom !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.copyFrom))) return { error: 'Channel to copy is not valid.' };
  return {
    name: (body.name as string).trim(),
    number: body.number as number | undefined,
    groupTitle: (body.groupTitle as string | undefined) ?? 'tunarr',
    transcodeConfigId: body.transcodeConfigId as string | undefined,
    copyFrom: body.copyFrom as string | undefined,
  };
}

// ------------------------------------------------------- transcode profiles

const HW_ACCELS = ['none', 'cuda', 'vaapi', 'qsv', 'videotoolbox'];
const VIDEO_FORMATS = ['h264', 'hevc', 'mpeg2video'];
const AUDIO_FORMATS = ['aac', 'ac3', 'copy', 'mp3', 'libopus', 'eac3'];
const ERROR_SCREENS = ['static', 'pic', 'blank', 'testsrc', 'text', 'kill'];
const ERROR_AUDIO = ['silent', 'sine', 'whitenoise'];
export const DEFAULT_LOUDNORM = { i: -24, lra: 7, tp: -2 };

const between = (min: number, max: number) => (value: unknown) => finite(value) && value >= min && value <= max;
const oneOf = (options: string[]) => (value: unknown) => typeof value === 'string' && options.includes(value);
const bool = (value: unknown) => typeof value === 'boolean';

/** Profile fields Lineup edits. Device paths and VAAPI drivers stay as Tunarr has them. */
export const TRANSCODE_FIELDS: Record<string, (value: unknown) => boolean> = {
  name: validName,
  threadCount: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 128,
  hardwareAccelerationMode: oneOf(HW_ACCELS),
  resolution: (value) => isObject(value) && Number.isInteger(value.widthPx) && Number.isInteger(value.heightPx) && between(16, 7680)(value.widthPx) && between(16, 4320)(value.heightPx),
  videoFormat: oneOf(VIDEO_FORMATS),
  videoBitDepth: (value) => value === 8 || value === 10 || value === null,
  videoBitRate: between(100, 200_000),
  videoBufferSize: between(100, 400_000),
  audioFormat: oneOf(AUDIO_FORMATS),
  audioBitRate: between(16, 1536),
  audioBufferSize: between(16, 6144),
  audioChannels: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 8,
  audioSampleRate: between(8, 192),
  audioVolumePercent: between(0, 400),
  audioLoudnormConfig: (value) => value === null || (isObject(value) && finite(value.i) && finite(value.lra) && finite(value.tp)),
  normalizeFrameRate: bool,
  deinterlaceVideo: bool,
  disableChannelOverlay: bool,
  errorScreen: oneOf(ERROR_SCREENS),
  errorScreenAudio: oneOf(ERROR_AUDIO),
  disableHardwareDecoder: bool,
  disableHardwareEncoding: bool,
  disableHardwareFilters: bool,
};

export function validateTranscodeChanges(body: unknown): { changes: Json } | { error: string } {
  if (!isObject(body)) return { error: 'Send profile changes as a JSON object.' };
  const changes: Json = {};
  for (const [key, value] of Object.entries(body)) {
    const check = TRANSCODE_FIELDS[key];
    if (!check) return { error: `"${key.slice(0, 40)}" can't be changed here.` };
    if (!check(value)) return { error: `"${key}" has an invalid value.` };
    changes[key] = key === 'name' ? (value as string).trim() : value;
  }
  return { changes };
}

export function transcodeSummary(config: unknown) {
  if (!isObject(config)) return null;
  const out: Json = { id: config.id, isDefault: !!config.isDefault };
  for (const key of Object.keys(TRANSCODE_FIELDS)) if (key in config) out[key] = config[key];
  return out;
}

// ----------------------------------------------------------- media sources

/** Sources with every library and its enabled state. No addresses, tokens, accounts or folder paths. */
export function manageableSources(sources: unknown) {
  if (!Array.isArray(sources)) return [];
  return sources.filter(isObject).map((source) => ({
    id: str(source.id),
    name: str(source.name) ?? 'Media source',
    type: str(source.type),
    mediaType: str(source.mediaType),
    libraries: (Array.isArray(source.libraries) ? source.libraries : []).filter(isObject).map((library) => ({
      id: str(library.id),
      name: str(library.name) ?? 'Library',
      mediaType: str(library.mediaType),
      enabled: library.enabled !== false,
      lastScannedAt: finite(library.lastScannedAt) ? library.lastScannedAt : undefined,
      isLocked: !!library.isLocked,
    })),
  }));
}

const MEDIA_TYPES = ['movies', 'shows', 'music_videos', 'other_videos', 'tracks'];

function serverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export type MediaSourceAdd =
  | { kind: 'insert'; body: Json }
  | { kind: 'login'; type: 'jellyfin' | 'emby'; name: string; uri: string; username: string; password: string };

export function validateMediaSourceAdd(body: unknown): MediaSourceAdd | { error: string } {
  if (!isObject(body)) return { error: 'Send the media source as a JSON object.' };
  if (!validName(body.name)) return { error: 'Give the media source a name.' };
  const name = (body.name as string).trim();
  switch (body.type) {
    case 'plex': {
      const uri = serverUrl(body.uri);
      if (!uri) return { error: 'Enter the Plex server address, like http://192.168.1.10:32400.' };
      if (typeof body.accessToken !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(body.accessToken.trim())) return { error: 'Enter the Plex token (X-Plex-Token).' };
      return { kind: 'insert', body: { type: 'plex', name, uri, accessToken: body.accessToken.trim(), userId: null, username: null, sendPlayStatusUpdates: false, sendGuideUpdates: false, pathReplacements: [] } };
    }
    case 'jellyfin':
    case 'emby': {
      const uri = serverUrl(body.uri);
      if (!uri) return { error: `Enter the ${body.type === 'emby' ? 'Emby' : 'Jellyfin'} server address, like http://192.168.1.10:8096.` };
      if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 200) return { error: 'Enter the user name.' };
      if (typeof body.password !== 'string' || !body.password || body.password.length > 500) return { error: 'Enter the password.' };
      return { kind: 'login', type: body.type, name, uri, username: body.username.trim(), password: body.password };
    }
    case 'local': {
      if (!MEDIA_TYPES.includes(body.mediaType as string)) return { error: 'Choose what the folders contain.' };
      if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 50) return { error: 'Add at least one folder.' };
      const paths = body.paths.map((path) => (typeof path === 'string' ? path.trim() : ''));
      if (paths.some((path) => !path || path.length > 1000 || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)))) return { error: 'Folders must be full paths on the Tunarr server, like /media/movies.' };
      return { kind: 'insert', body: { type: 'local', name, mediaType: body.mediaType, paths, pathReplacements: [] } };
    }
    default:
      return { error: 'Choose Plex, Jellyfin, Emby or local folders.' };
  }
}

// -------------------------------------------------------- smart collections

export type SmartCollectionBody = { name?: string; keywords?: string; filter?: Json | null };

export function validateSmartCollection(body: unknown, creating: boolean): { body: SmartCollectionBody } | { error: string } {
  if (!isObject(body)) return { error: 'Send the collection as a JSON object.' };
  const out: SmartCollectionBody = {};
  if (creating || body.name !== undefined) {
    if (!validName(body.name)) return { error: 'The collection needs a name (up to 200 characters).' };
    out.name = (body.name as string).trim();
  }
  if (body.keywords !== undefined) {
    if (typeof body.keywords !== 'string' || body.keywords.length > 200) return { error: 'Keywords are too long.' };
    out.keywords = body.keywords.trim();
  } else if (creating) out.keywords = '';
  if (creating || body.rules !== undefined) {
    const built = rulesToFilter({ match: body.match ?? 'all', rules: body.rules ?? [] });
    if ('error' in built) return built;
    out.filter = built.filter;
  }
  if (creating && !out.filter && !out.keywords) return { error: 'Add a rule or keywords so the collection has something to match.' };
  // Tunarr's update keeps the old filter when none is sent, so rules can't be removed entirely.
  if (!creating && out.filter === null) return { error: 'Keep at least one rule. Tunarr can’t remove every rule from a saved collection.' };
  return { body: out };
}

function collectionView(item: unknown) {
  if (!isObject(item)) return null;
  const rules = filterToRules(item.filter);
  return {
    id: str(item.uuid) ?? str(item.id),
    name: str(item.name) ?? 'Smart collection',
    keywords: str(item.keywords) ?? '',
    rules,
    description: rules ? describeRules(rules) : str(item.filterString) ?? '',
    filterString: str(item.filterString) ?? '',
  };
}

// ------------------------------------------------------------------ routing

type Context = {
  config: ProxyConfig;
  target: TunarrTarget;
  method: string;
  body: unknown;
  withChannelLock: <T>(channelId: string, task: () => Promise<T>) => Promise<T>;
};

export async function handleAdminRoute(route: AdminRoute, { config, target, method, body, withChannelLock }: Context): Promise<ProxyResponse> {
  const call = (verb: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown, notFound?: string) =>
    callTunarr(config, target, verb, path, payload === undefined ? undefined : JSON.stringify(payload), notFound);
  const invalid = (message: string) => fail(400, 'invalid_request', message);

  switch (route.name) {
    case 'channel-create': {
      const checked = validateChannelCreate(body);
      if ('error' in checked) return invalid(checked.error);
      const channels = await call('GET', '/api/channels');
      const list = (Array.isArray(channels) ? channels : []).filter(isObject);
      const number = checked.number ?? list.reduce((max, channel) => Math.max(max, Number(channel.number) || 0), 0) + 1;
      if (list.some((channel) => channel.number === number)) return fail(409, 'number_taken', `Channel ${number} already exists.`);
      if (checked.copyFrom) {
        const copied = (await call('POST', '/api/channels', { type: 'copy', channelId: checked.copyFrom }, 'Tunarr could not find the channel to copy.')) as Json | null;
        const id = str(copied?.id);
        if (!id) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr did not return the new channel.');
        // Tunarr names copies itself; apply the requested name and number.
        await withChannelLock(id, async () => {
          const current = await call('GET', `/api/channels/${id}`);
          if (!isObject(current)) return;
          const next: Json = { ...current, name: checked.name, number, groupTitle: checked.groupTitle || current.groupTitle };
          for (const field of ['programCount', 'sessions', 'fallback', 'transcoding']) delete next[field];
          await call('PUT', `/api/channels/${id}`, next);
        });
        return json(201, { id, name: checked.name, number });
      }
      let transcodeConfigId = checked.transcodeConfigId;
      if (!transcodeConfigId) {
        const configs = await call('GET', '/api/transcode_configs');
        const items = (Array.isArray(configs) ? configs : []).filter(isObject);
        transcodeConfigId = str((items.find((item) => item.isDefault) ?? items[0])?.id);
        if (!transcodeConfigId) return fail(409, 'no_transcode_profile', 'Tunarr has no transcode profile to give the channel.');
      }
      const created = (await call('POST', '/api/channels', { type: 'new', channel: newChannel(checked.name, number, transcodeConfigId, checked.groupTitle) })) as Json | null;
      return json(201, { id: str(created?.id), name: checked.name, number });
    }
    case 'channel':
      return withChannelLock(route.channelId, async () => json(200, (await call('DELETE', `/api/channels/${route.channelId}`)) ?? { deleted: true }));

    case 'transcode-configs': {
      const items = await call('GET', '/api/transcode_configs');
      return json(200, (Array.isArray(items) ? items : []).map(transcodeSummary).filter(Boolean));
    }
    case 'transcode-config': {
      const path = `/api/transcode_configs/${route.id}`;
      const notFound = 'Tunarr could not find that transcode profile.';
      if (method === 'DELETE') {
        const current = (await call('GET', path, undefined, notFound)) as Json | null;
        if (current?.isDefault) return fail(409, 'default_profile', 'The default profile can’t be deleted.');
        const channels = await call('GET', '/api/channels');
        const users = (Array.isArray(channels) ? channels : []).filter((channel) => isObject(channel) && channel.transcodeConfigId === route.id);
        if (users.length) return fail(409, 'profile_in_use', `${users.length} ${users.length === 1 ? 'channel uses' : 'channels use'} this profile. Move them to another profile first.`);
        return json(200, (await call('DELETE', path, undefined, notFound)) ?? { deleted: true });
      }
      const checked = validateTranscodeChanges(body);
      if ('error' in checked) return invalid(checked.error);
      // Merge onto Tunarr's copy so fields Lineup doesn't edit are kept.
      const current = await call('GET', path, undefined, notFound);
      if (!isObject(current)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected profile.');
      return json(200, transcodeSummary(await call('PUT', path, { ...current, ...checked.changes }, notFound)));
    }
    case 'transcode-config-copy':
      return json(201, transcodeSummary(await call('POST', `/api/transcode_configs/${route.id}/copy`, undefined, 'Tunarr could not find that transcode profile.')));

    case 'media-sources-manage':
      return json(200, manageableSources(await call('GET', '/api/media-sources')));
    case 'media-source-add': {
      const checked = validateMediaSourceAdd(body);
      if ('error' in checked) return invalid(checked.error);
      let insert = checked.kind === 'insert' ? checked.body : null;
      if (checked.kind === 'login') {
        // Tunarr signs in to the server; Lineup keeps neither the password nor the token.
        let login: Json | null;
        try {
          login = (await call('POST', `/api/${checked.type}/login`, { url: checked.uri, username: checked.username, password: checked.password })) as Json | null;
        } catch (error) {
          if (error instanceof UpstreamError && (error.status === 502 || error.status === 400)) {
            return fail(502, 'media_server_login_failed', `Tunarr couldn’t sign in to that ${checked.type === 'emby' ? 'Emby' : 'Jellyfin'} server. Check the address, user name and password.`);
          }
          throw error;
        }
        if (!str(login?.accessToken)) return fail(502, 'media_server_login_failed', 'The server didn’t accept those credentials.');
        insert = { type: checked.type, name: checked.name, uri: checked.uri, accessToken: login!.accessToken, userId: str(login!.userId) ?? null, username: checked.username, sendPlayStatusUpdates: false, pathReplacements: [] };
      }
      const created = (await call('POST', '/api/media-sources', insert)) as Json | null;
      const id = str(created?.id);
      if (id && insert!.type !== 'local') {
        // Ask Tunarr to read the server's libraries so they can be enabled right away.
        try {
          await call('POST', `/api/media-sources/${id}/libraries/refresh`);
        } catch {
          // Not fatal; libraries also refresh on Tunarr's own schedule.
        }
      }
      return json(201, { id });
    }
    case 'media-source':
      return json(200, (await call('DELETE', `/api/media-sources/${route.id}`, undefined, 'Tunarr could not find that media source.')) ?? { deleted: true });
    case 'media-source-refresh':
      await call('POST', `/api/media-sources/${route.id}/libraries/refresh`, undefined, 'Tunarr could not find that media source.');
      return json(200, { refreshed: true });
    case 'media-library': {
      if (!isObject(body) || typeof body.enabled !== 'boolean') return invalid('Send { "enabled": true | false }.');
      const library = (await call('PUT', `/api/media-sources/${route.id}/libraries/${route.libraryId}`, { enabled: body.enabled }, 'Tunarr could not find that library.')) as Json | null;
      return json(200, { id: str(library?.id) ?? route.libraryId, enabled: library?.enabled !== false });
    }
    case 'media-library-scan':
      await call('POST', `/api/media-sources/${route.id}/libraries/${route.libraryId}/scan?forceScan=true`, undefined, 'Tunarr could not find that library.');
      return json(202, { scanning: true });

    case 'smart-collection-create': {
      const checked = validateSmartCollection(body, true);
      if ('error' in checked) return invalid(checked.error);
      const created = await call('POST', '/api/smart_collections', { name: checked.body.name, keywords: checked.body.keywords ?? '', ...(checked.body.filter ? { filter: checked.body.filter } : {}) });
      return json(201, collectionView(created));
    }
    case 'smart-collection-preview': {
      const checked = validateSmartCollection({ name: 'preview', ...(isObject(body) ? body : {}) }, true);
      if ('error' in checked) return invalid(checked.error);
      const query: Json = {};
      if (checked.body.keywords) query.query = checked.body.keywords;
      if (checked.body.filter) query.filter = checked.body.filter;
      // Free-text searches page from 1, filter-only listings from 0 (see buildLibrarySearch).
      const result = (await call('POST', '/api/programs/search', { query, page: query.query ? 1 : 0, limit: 12 })) as Json | null;
      const results = Array.isArray(result?.results) ? result!.results.filter(isObject) : [];
      return json(200, {
        totalHits: finite(result?.totalHits) ? result!.totalHits : results.length,
        sample: results.map((item) => ({ id: str(item.uuid), title: str(item.title) ?? 'Untitled', type: str(item.type), year: finite(item.year) ? item.year : undefined })),
      });
    }
    case 'smart-collection': {
      const path = `/api/smart_collections/${route.id}`;
      const notFound = 'Tunarr could not find that smart collection.';
      if (method === 'GET') return json(200, collectionView(await call('GET', path, undefined, notFound)));
      if (method === 'DELETE') return json(200, (await call('DELETE', path, undefined, notFound)) ?? { deleted: true });
      const checked = validateSmartCollection(body, false);
      if ('error' in checked) return invalid(checked.error);
      const update: Json = {};
      if (checked.body.name !== undefined) update.name = checked.body.name;
      if (checked.body.keywords !== undefined) update.keywords = checked.body.keywords;
      if (checked.body.filter) update.filter = checked.body.filter;
      return json(200, collectionView(await call('PUT', path, update, notFound)));
    }
  }
}
