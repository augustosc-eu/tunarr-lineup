// Routes for managing what channels are made of: browsing Tunarr's indexed
// libraries, filler lists ("commercials"), custom shows, smart collections,
// and a channel's programming-related settings. Like the rest of the proxy,
// each route is explicit, inputs are validated before any upstream call, and
// responses are trimmed to what the interface needs.
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json, UpstreamError } from './upstream.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEARCH_TYPES = ['show', 'season', 'episode', 'movie', 'other_video', 'music_video', 'artist', 'album', 'track'] as const;
export const MAX_LIST_ITEMS = 20_000;
const MAX_NAME = 200;

export type ContentRoute =
  | { name: 'media-sources'; methods: string[] }
  | { name: 'library-search'; methods: string[] }
  | { name: 'descendants'; methods: string[]; id: string }
  | { name: 'filler-lists'; methods: string[] }
  | { name: 'filler-list'; methods: string[]; id: string }
  | { name: 'filler-list-programs'; methods: string[]; id: string }
  | { name: 'custom-shows'; methods: string[] }
  | { name: 'custom-show'; methods: string[]; id: string }
  | { name: 'custom-show-programs'; methods: string[]; id: string }
  | { name: 'smart-collections'; methods: string[] }
  | { name: 'channel-settings'; methods: string[]; channelId: string };

/** Matches a path below /api/tunarr. Ids must be UUIDs (raw, still encoded). */
export function matchContentRoute(path: string, channelIdPattern: RegExp): ContentRoute | { invalid: string } | null {
  if (path === '/media-sources') return { name: 'media-sources', methods: ['GET'] };
  if (path === '/library/search') return { name: 'library-search', methods: ['POST'] };
  if (path === '/filler-lists') return { name: 'filler-lists', methods: ['GET', 'POST'] };
  if (path === '/custom-shows') return { name: 'custom-shows', methods: ['GET', 'POST'] };
  if (path === '/smart-collections') return { name: 'smart-collections', methods: ['GET'] };
  let match = /^\/programs\/([^/]+)\/descendants$/.exec(path);
  if (match) return UUID.test(match[1]) ? { name: 'descendants', methods: ['GET'], id: match[1] } : { invalid: 'Program id is not valid.' };
  match = /^\/(filler-lists|custom-shows)\/([^/]+)(\/programs)?$/.exec(path);
  if (match) {
    if (!UUID.test(match[2])) return { invalid: 'List id is not valid.' };
    const kind = match[1] === 'filler-lists' ? 'filler-list' : 'custom-show';
    return match[3]
      ? { name: `${kind}-programs` as 'filler-list-programs' | 'custom-show-programs', methods: ['GET'], id: match[2] }
      : { name: kind, methods: ['PUT', 'DELETE'], id: match[2] };
  }
  match = /^\/channels\/([^/]+)\/settings$/.exec(path);
  if (match) return channelIdPattern.test(match[1]) ? { name: 'channel-settings', methods: ['GET', 'PUT'], channelId: match[1] } : { invalid: 'Channel id is not valid.' };
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

function validName(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME;
}

// ---------------------------------------------------------------- libraries

/** Media sources and their enabled libraries. Server addresses and accounts are never passed on. */
export function sanitizeMediaSources(sources: unknown) {
  if (!Array.isArray(sources)) return [];
  return sources.filter(isObject).map((source) => ({
    id: str(source.id),
    name: str(source.name) ?? 'Media source',
    type: str(source.type),
    mediaType: str(source.mediaType),
    libraries: (Array.isArray(source.libraries) ? source.libraries : [])
      .filter(isObject)
      .filter((library) => library.enabled !== false)
      .map((library) => ({ id: str(library.id), name: str(library.name) ?? 'Library', mediaType: str(library.mediaType) })),
  }));
}

const typeFilter = (type: string) => ({ type: 'value', fieldSpec: { key: 'type', name: 'Type', op: '=', type: 'string', value: [type] } });
const parentFilter = (id: string) => ({ type: 'value', fieldSpec: { key: 'parent.id', name: '', op: '=', type: 'string', value: [id] } });

/** Builds Tunarr's search request from a small, validated query (no raw filters accepted). */
export function buildLibrarySearch(body: unknown): { request: Json } | { error: string } {
  if (!isObject(body)) return { error: 'Search must be a JSON object.' };
  const { mediaSourceId, libraryId, text, type, parentId, page = 0, limit = 40 } = body;
  if (typeof mediaSourceId !== 'string' || !UUID.test(mediaSourceId)) return { error: 'Choose a media source.' };
  if (libraryId !== undefined && (typeof libraryId !== 'string' || !UUID.test(libraryId))) return { error: 'Library id is not valid.' };
  if (text !== undefined && (typeof text !== 'string' || text.length > 200)) return { error: 'Search text is too long.' };
  if (type !== undefined && !(SEARCH_TYPES as readonly unknown[]).includes(type)) return { error: 'Unsupported item type.' };
  if (parentId !== undefined && (typeof parentId !== 'string' || !UUID.test(parentId))) return { error: 'Parent id is not valid.' };
  if (!Number.isInteger(page) || (page as number) < 0 || (page as number) > 10_000) return { error: 'Page is out of range.' };
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) return { error: 'Limit must be 1–100.' };
  const filters = [type ? typeFilter(type as string) : null, parentId ? parentFilter(parentId as string) : null].filter(Boolean);
  const filter = filters.length > 1 ? { type: 'op', op: 'and', children: filters } : filters[0] ?? null;
  const query: Json = {};
  if (typeof text === 'string' && text.trim()) query.query = text.trim();
  if (filter) query.filter = filter;
  // Tunarr pages free-text searches from 1 and plain listings from 0
  // (SearchProgramsCommand). Lineup always counts from 0.
  return { request: { mediaSourceId, libraryId, query, page: query.query ? (page as number) + 1 : page, limit } };
}

// ------------------------------------------------------------ list contents

/** Validates program entries for a filler list (full content programs) or custom show (condensed). */
function validatePrograms(value: unknown, kind: 'filler' | 'custom'): { programs: Json[] } | { error: string } {
  if (!Array.isArray(value)) return { error: '"programs" must be an array.' };
  if (value.length > MAX_LIST_ITEMS) return { error: 'Too many programs.' };
  const programs: Json[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isObject(raw)) return { error: `Program ${index + 1} must be an object.` };
    const allowedTypes = kind === 'filler' ? ['content', 'custom'] : ['content'];
    if (!allowedTypes.includes(String(raw.type))) return { error: `Program ${index + 1} has an unsupported type.` };
    if (typeof raw.id !== 'string' || !UUID.test(raw.id)) return { error: `Program ${index + 1} needs a program id.` };
    if (!finite(raw.duration) || raw.duration <= 0) return { error: `Program ${index + 1} needs a positive duration.` };
    if (kind === 'filler' && raw.type === 'content' && !isObject(raw.program)) return { error: `Program ${index + 1} is missing its details.` };
    programs.push(kind === 'custom' ? { type: 'content', id: raw.id, duration: raw.duration } : raw);
  }
  return { programs };
}

export function validateFillerListBody(body: unknown, creating: boolean): { body: Json } | { error: string } {
  if (!isObject(body)) return { error: 'Send the list as a JSON object.' };
  const out: Json = {};
  if (creating || body.name !== undefined) {
    if (!validName(body.name)) return { error: 'The list needs a name (up to 200 characters).' };
    out.name = (body.name as string).trim();
  }
  if (creating || body.programs !== undefined) {
    const checked = validatePrograms(body.programs, 'filler');
    if ('error' in checked) return checked;
    if (!checked.programs.length) return { error: 'A filler list needs at least one program.' };
    out.programs = checked.programs;
  }
  return { body: out };
}

export function validateCustomShowBody(body: unknown, creating: boolean): { body: Json } | { error: string } {
  if (!isObject(body)) return { error: 'Send the show as a JSON object.' };
  const out: Json = {};
  if (creating || body.name !== undefined) {
    if (!validName(body.name)) return { error: 'The show needs a name (up to 200 characters).' };
    out.name = (body.name as string).trim();
  }
  if (creating || body.programs !== undefined) {
    const checked = validatePrograms(body.programs ?? [], 'custom');
    if ('error' in checked) return checked;
    out.programs = checked.programs;
  }
  return { body: out };
}

const listSummary = (list: Json) => ({
  id: str(list.id),
  name: str(list.name) ?? 'Untitled',
  contentCount: finite(list.contentCount) ? list.contentCount : undefined,
  totalDuration: finite(list.totalDuration) ? list.totalDuration : undefined,
  synced: !!list.syncMediaSourceId,
});

// --------------------------------------------------------- channel settings

/** Channel fields Lineup reads and may change. Everything else is left exactly as Tunarr has it. */
export const CHANNEL_SETTING_FIELDS = [
  'name', 'number', 'groupTitle', 'startTime', 'guideFlexTitle', 'guideMinimumDuration', 'fillerCollections', 'fillerRepeatCooldown', 'disableFillerOverlay',
  'icon', 'watermark', 'offline', 'streamMode', 'transcodeConfigId', 'subtitlesEnabled', 'stealth', 'onDemand',
] as const;
export const STREAM_MODES = ['hls', 'hls_slower', 'mpegts', 'hls_direct', 'hls_direct_v2'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** An image URL Tunarr will load (http/https or one of its own /images paths), or empty. */
function imageUrl(value: unknown) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 2000) return false;
  if (value.startsWith('/images/')) return !value.includes('..');
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}
const percent = (value: unknown) => finite(value) && value >= 0 && value <= 100;

function validateIcon(value: unknown, current: unknown): Json | string {
  if (!isObject(value)) return 'Logo must be an object.';
  const base = isObject(current) ? current : {};
  const out: Json = { path: base.path ?? '', width: base.width ?? 0, duration: base.duration ?? 0, position: base.position ?? 'bottom-right', ...(base.useDefaultIconFallback !== undefined ? { useDefaultIconFallback: base.useDefaultIconFallback } : {}) };
  if (value.path !== undefined) {
    if (!imageUrl(value.path)) return 'Logo must be an http(s) image address.';
    out.path = value.path;
  }
  if (value.width !== undefined) {
    if (!finite(value.width) || value.width < 0 || value.width > 100) return 'Logo width must be 0–100.';
    out.width = value.width;
  }
  if (value.position !== undefined) {
    if (!CORNERS.includes(value.position as string)) return 'Logo position must be a corner.';
    out.position = value.position;
  }
  return out;
}

function validateWatermark(value: unknown, current: unknown): Json | string {
  if (!isObject(value)) return 'Watermark must be an object.';
  const base: Json = isObject(current) ? { ...current } : { enabled: false, position: 'bottom-right', width: 10, verticalMargin: 1, horizontalMargin: 1, duration: 0, opacity: 100 };
  for (const [key, field] of Object.entries(value)) {
    switch (key) {
      case 'enabled': case 'fixedSize': case 'animated':
        if (typeof field !== 'boolean') return `Watermark "${key}" must be true or false.`;
        break;
      case 'url':
        if (!imageUrl(field)) return 'Watermark image must be an http(s) address.';
        break;
      case 'position':
        if (!CORNERS.includes(field as string)) return 'Watermark position must be a corner.';
        break;
      case 'width':
        if (!finite(field) || field <= 0 || field > 100) return 'Watermark width must be 1–100%.';
        break;
      case 'verticalMargin': case 'horizontalMargin':
        if (!percent(field)) return 'Watermark margins must be 0–100%.';
        break;
      case 'opacity':
        if (!Number.isInteger(field) || !percent(field)) return 'Watermark opacity must be 0–100.';
        break;
      case 'duration':
        if (!finite(field) || field < 0) return 'Watermark duration must be 0 or more.';
        break;
      default:
        return `Watermark "${key.slice(0, 40)}" can't be changed here.`;
    }
    base[key] = field;
  }
  return base;
}

function validateOffline(value: unknown, current: unknown): Json | string {
  if (!isObject(value)) return 'Offline screen must be an object.';
  const base: Json = isObject(current) ? { ...current } : { mode: 'pic', picture: '', soundtrack: '' };
  if (value.mode !== undefined) {
    if (value.mode !== 'pic' && value.mode !== 'clip') return 'Offline mode must be "pic" or "clip".';
    base.mode = value.mode;
  }
  for (const key of ['picture', 'soundtrack'] as const) {
    if (value[key] === undefined) continue;
    if (!imageUrl(value[key])) return `Offline ${key} must be an http(s) address.`;
    base[key] = value[key];
  }
  return base;
}
// Read-only or response-only fields Tunarr's save schema does not accept.
const NOT_SAVEABLE = ['programCount', 'sessions', 'fallback', 'transcoding'];

export function channelSettings(channel: unknown) {
  if (!isObject(channel)) return {};
  const out: Json = { id: channel.id, duration: channel.duration };
  for (const field of CHANNEL_SETTING_FIELDS) if (field in channel) out[field] = channel[field];
  return out;
}

export function validateChannelSettings(body: unknown, current: Json = {}): { changes: Json } | { error: string } {
  if (!isObject(body)) return { error: 'Send settings as a JSON object.' };
  const changes: Json = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(CHANNEL_SETTING_FIELDS as readonly string[]).includes(key)) return { error: `"${key.slice(0, 40)}" can't be changed here.` };
    switch (key) {
      case 'name':
        if (!validName(value)) return { error: 'Channel name is required (up to 200 characters).' };
        changes.name = (value as string).trim();
        break;
      case 'number':
        if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 99_999) return { error: 'Channel number must be a whole number from 1.' };
        changes.number = value;
        break;
      case 'groupTitle':
      case 'guideFlexTitle':
        if (typeof value !== 'string' || value.length > MAX_NAME) return { error: `"${key}" must be text.` };
        changes[key] = value;
        break;
      case 'startTime':
      case 'guideMinimumDuration':
      case 'fillerRepeatCooldown':
        if (!Number.isInteger(value) || (value as number) < 0) return { error: `"${key}" must be a whole number of milliseconds.` };
        changes[key] = value;
        break;
      case 'disableFillerOverlay':
        if (typeof value !== 'boolean') return { error: '"disableFillerOverlay" must be true or false.' };
        changes[key] = value;
        break;
      case 'fillerCollections': {
        if (!Array.isArray(value) || value.length > 100) return { error: 'Filler collections must be a list.' };
        const collections = [];
        for (const item of value) {
          if (!isObject(item) || typeof item.id !== 'string' || !UUID.test(item.id) || !finite(item.weight) || item.weight < 0 || !finite(item.cooldownSeconds) || item.cooldownSeconds < 0) {
            return { error: 'Each filler collection needs a filler list, a weight and a cooldown of 0 or more.' };
          }
          collections.push({ id: item.id, weight: item.weight, cooldownSeconds: item.cooldownSeconds });
        }
        changes.fillerCollections = collections;
        break;
      }
      case 'subtitlesEnabled':
      case 'stealth':
        if (typeof value !== 'boolean') return { error: `"${key}" must be true or false.` };
        changes[key] = value;
        break;
      case 'onDemand':
        if (!isObject(value) || typeof value.enabled !== 'boolean') return { error: 'On-demand must be { "enabled": true | false }.' };
        changes.onDemand = { enabled: value.enabled };
        break;
      case 'streamMode':
        if (!(STREAM_MODES as readonly unknown[]).includes(value)) return { error: 'Unknown stream mode.' };
        changes.streamMode = value;
        break;
      case 'transcodeConfigId':
        if (typeof value !== 'string' || !UUID.test(value)) return { error: 'Choose a transcode profile.' };
        changes.transcodeConfigId = value;
        break;
      case 'icon':
      case 'watermark':
      case 'offline': {
        const merged = key === 'icon' ? validateIcon(value, current.icon) : key === 'watermark' ? validateWatermark(value, current.watermark) : validateOffline(value, current.offline);
        if (typeof merged === 'string') return { error: merged };
        changes[key] = merged;
        break;
      }
    }
  }
  return { changes };
}

// ------------------------------------------------------------------ routing

type Context = {
  config: ProxyConfig;
  target: TunarrTarget;
  method: string;
  body: unknown;
  withChannelLock: <T>(channelId: string, task: () => Promise<T>) => Promise<T>;
};

const LIST_NOT_FOUND = 'Tunarr could not find that list.';

export async function handleContentRoute(route: ContentRoute, { config, target, method, body, withChannelLock }: Context): Promise<ProxyResponse> {
  const call = (verb: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown, notFound?: string) =>
    callTunarr(config, target, verb, path, payload === undefined ? undefined : JSON.stringify(payload), notFound);
  const invalid = (message: string) => fail(400, 'invalid_request', message);

  switch (route.name) {
    case 'media-sources':
      return json(200, sanitizeMediaSources(await call('GET', '/api/media-sources')));
    case 'library-search': {
      const built = buildLibrarySearch(body);
      if ('error' in built) return invalid(built.error);
      return json(200, await call('POST', '/api/programs/search', built.request));
    }
    case 'descendants': {
      const items = await call('GET', `/api/programs/${route.id}/descendants`, undefined, 'Tunarr could not find that show or season.');
      return json(200, Array.isArray(items) ? items.slice(0, MAX_LIST_ITEMS) : []);
    }
    case 'smart-collections': {
      const items = await call('GET', '/api/smart_collections');
      return json(200, (Array.isArray(items) ? items : []).filter(isObject).map((item) => ({ id: str(item.uuid) ?? str(item.id), name: str(item.name) ?? 'Smart collection' })));
    }
    case 'filler-lists':
    case 'custom-shows': {
      const base = route.name === 'filler-lists' ? '/api/filler-lists' : '/api/custom-shows';
      if (method === 'GET') {
        const items = await call('GET', base);
        return json(200, (Array.isArray(items) ? items : []).filter(isObject).map(listSummary));
      }
      if (route.name === 'filler-lists') {
        const checked = validateFillerListBody(body, true);
        if ('error' in checked) return invalid(checked.error);
        return json(201, await call('POST', base, checked.body));
      }
      const checked = validateCustomShowBody(body, true);
      if ('error' in checked) return invalid(checked.error);
      return json(201, await call('POST', base, { ...checked.body, syncMediaSourceId: null, syncMediaSourceType: null, syncExternalPlaylistId: null }));
    }
    case 'filler-list-programs':
      return json(200, await call('GET', `/api/filler-lists/${route.id}/programs`, undefined, LIST_NOT_FOUND));
    case 'custom-show-programs':
      return json(200, await call('GET', `/api/custom-shows/${route.id}/programs`, undefined, LIST_NOT_FOUND));
    case 'filler-list': {
      if (method === 'DELETE') return json(200, (await call('DELETE', `/api/filler-lists/${route.id}`, undefined, LIST_NOT_FOUND)) ?? { deleted: true });
      const checked = validateFillerListBody(body, false);
      if ('error' in checked) return invalid(checked.error);
      return json(200, await call('PUT', `/api/filler-lists/${route.id}`, checked.body, LIST_NOT_FOUND));
    }
    case 'custom-show': {
      if (method === 'DELETE') return json(200, (await call('DELETE', `/api/custom-shows/${route.id}`, undefined, LIST_NOT_FOUND)) ?? { deleted: true });
      const checked = validateCustomShowBody(body, false);
      if ('error' in checked) return invalid(checked.error);
      // Tunarr clears playlist sync unless the update re-states it, so keep whatever the show has.
      const current = (await call('GET', `/api/custom-shows/${route.id}`, undefined, LIST_NOT_FOUND)) as Json | null;
      const synced = !!current?.syncMediaSourceId;
      return json(200, await call('PUT', `/api/custom-shows/${route.id}`, {
        ...checked.body,
        enableSync: synced,
        syncMediaSourceId: current?.syncMediaSourceId ?? null,
        syncMediaSourceType: current?.syncMediaSourceType ?? null,
        syncExternalPlaylistId: current?.syncExternalPlaylistId ?? null,
      }, LIST_NOT_FOUND));
    }
    case 'channel-settings': {
      const path = `/api/channels/${route.channelId}`;
      if (method === 'GET') return json(200, channelSettings(await call('GET', path)));
      const precheck = validateChannelSettings(body);
      if ('error' in precheck) return invalid(precheck.error);
      return withChannelLock(route.channelId, async () => {
        // Merge onto Tunarr's current channel so fields Lineup doesn't manage are untouched.
        const current = await call('GET', path);
        if (!isObject(current)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
        const checked = validateChannelSettings(body, current);
        if ('error' in checked) return invalid(checked.error);
        const next: Json = { ...current, ...checked.changes };
        for (const field of NOT_SAVEABLE) delete next[field];
        await call('PUT', path, next);
        return json(200, channelSettings(await call('GET', path)));
      });
    }
  }
}
