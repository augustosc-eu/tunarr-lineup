import { keptStartTime, lineupLength, programmingVersion } from './lineupVersion.js';
import path from 'node:path';
import { handleAdminRoute, matchAdminRoute, type AdminRoute } from './admin.js';
import { createAiConfig, type AiConfig } from './ai.js';
import { handleLineupRoute, matchLineupRoute, type LineupRoute } from './lineupRoutes.js';
import { createTemplateStore, type TemplateStore } from './templateStore.js';
import { handleContentRoute, matchContentRoute, NOT_SAVEABLE, type ContentRoute } from './content.js';
import { channelLogo, type ExternalImageFetcher } from './logos.js';
import { callTunarr, fail, fetchUpstream, json, UpstreamError } from './upstream.js';
import { buildSchedule, programPool, validateExtraPrograms, validateSeed } from './slotSchedule.js';

// Narrow backend-for-frontend for Tunarr.
//
// The browser only ever talks to /api/tunarr/* on this app's own origin. This
// module maps those few routes onto Tunarr's channel API at TUNARR_URL. It is
// deliberately not a general proxy: the upstream origin is fixed by server
// configuration, only the routes and methods below are allowed, and every
// path segment, query parameter and request body is validated first.

export type TunarrTarget = {
  /** Scheme + host + port, never including credentials. */
  origin: string;
  /** Optional path prefix when Tunarr sits behind a reverse proxy. */
  basePath: string;
  /** Host shown to users in status messages (no credentials). */
  host: string;
  /** Only set when the operator put credentials in TUNARR_URL. */
  authorization?: string;
};

export type ProxyConfig = {
  target: TunarrTarget | null;
  configError?: string;
  timeoutMs: number;
  saveTimeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Load channel logos hosted on public sites (LINEUP_EXTERNAL_LOGOS, default on). */
  externalLogos?: boolean;
  /** Test hook for the public-logo fetch. */
  fetchExternalImage?: ExternalImageFetcher;
  /** Saved programming templates (LINEUP_DATA_DIR). */
  templates?: TemplateStore;
  /** AI programming assistant (LINEUP_AI_*), or why it is off. */
  ai?: AiConfig | { off: string };
};

export type ProxyRequest = {
  method: string;
  /** Path and query string as received, e.g. /api/tunarr/channels?x=1 */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string>;
  /** JSON text, or raw bytes for artwork. */
  body: string | Uint8Array;
};

export const API_PREFIX = '/api/tunarr';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_SAVE_TIMEOUT_MS = 30_000;
export const MAX_LINEUP_RANGE_MS = 14 * 24 * 3_600_000;
export const MAX_LINEUP_ITEMS = 100_000;
export const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
export const ARTWORK_TYPES = ['poster', 'thumbnail', 'landscape', 'banner'] as const;

const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LINEUP_ITEM_TYPES = new Set(['content', 'custom', 'filler', 'flex', 'redirect']);
const ITEM_ID_REQUIRED = new Set(['content', 'custom', 'filler']);
const PROGRAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|avif)$/i;

export function parseTunarrUrl(raw: string | undefined): { target: TunarrTarget } | { error: string } | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'TUNARR_URL is not a valid URL. Use a value like http://tunarr:8000.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'TUNARR_URL must start with http:// or https://.' };
  }
  if (url.search || url.hash) {
    return { error: 'TUNARR_URL must not include a query string or fragment.' };
  }
  let authorization: string | undefined;
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password);
    authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return {
    target: {
      origin: `${url.protocol}//${url.host}`,
      basePath: url.pathname.replace(/\/+$/, ''),
      host: url.host,
      authorization,
    },
  };
}

function positiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createProxyConfig(env: Record<string, string | undefined>): ProxyConfig {
  const parsed = parseTunarrUrl(env.TUNARR_URL);
  return {
    target: parsed && 'target' in parsed ? parsed.target : null,
    configError: parsed && 'error' in parsed ? parsed.error : undefined,
    timeoutMs: positiveInt(env.TUNARR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    saveTimeoutMs: positiveInt(env.TUNARR_SAVE_TIMEOUT_MS, DEFAULT_SAVE_TIMEOUT_MS),
    externalLogos: env.LINEUP_EXTERNAL_LOGOS?.trim().toLowerCase() !== 'false',
    templates: createTemplateStore(path.resolve(env.LINEUP_DATA_DIR?.trim() || 'data')),
    ai: createAiConfig(env),
  };
}

type Route =
  | { name: 'health'; methods: string[] }
  | { name: 'channels'; methods: string[] }
  | { name: 'programming'; methods: string[]; channelId: string }
  | { name: 'lineup'; methods: string[]; channelId: string }
  | { name: 'schedule'; methods: string[]; channelId: string }
  | { name: 'schedule-preview'; methods: string[]; channelId: string }
  | { name: 'logo'; methods: string[]; channelId: string }
  | { name: 'artwork'; methods: string[]; programId: string; artworkType: string };

function matchRoute(pathname: string): Route | { invalid: string } | null {
  if (pathname === `${API_PREFIX}/health`) return { name: 'health', methods: ['GET'] };
  if (pathname === `${API_PREFIX}/channels`) return { name: 'channels', methods: ['GET'] };
  const artwork = /^\/api\/tunarr\/programs\/([^/]+)\/artwork\/([^/]+)$/.exec(pathname);
  if (artwork) {
    if (!PROGRAM_ID.test(artwork[1])) return { invalid: 'Program id is not valid.' };
    if (!(ARTWORK_TYPES as readonly string[]).includes(artwork[2])) return { invalid: 'Artwork type is not supported.' };
    return { name: 'artwork', methods: ['GET'], programId: artwork[1].toLowerCase(), artworkType: artwork[2] };
  }
  const match = /^\/api\/tunarr\/channels\/([^/]+)\/(programming|lineup|schedule|schedule-preview|logo)$/.exec(pathname);
  if (!match) return null;
  // Validate the raw (still percent-encoded) segment so encoded slashes or
  // dots can never reach the upstream URL.
  if (!CHANNEL_ID.test(match[1])) return { invalid: 'Channel id is not valid.' };
  switch (match[2]) {
    case 'programming': return { name: 'programming', methods: ['GET', 'POST'], channelId: match[1] };
    case 'lineup': return { name: 'lineup', methods: ['GET'], channelId: match[1] };
    case 'schedule': return { name: 'schedule', methods: ['GET'], channelId: match[1] };
    case 'logo': return { name: 'logo', methods: ['GET'], channelId: match[1] };
    default: return { name: 'schedule-preview', methods: ['POST'], channelId: match[1] };
  }
}

// Writes to one channel are serialized, so the version check and the write
// below cannot interleave with another Lineup session's save.
const channelLocks = new Map<string, Promise<unknown>>();

async function withChannelLock<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = channelLocks.get(channelId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  channelLocks.set(channelId, settled);
  try {
    return await run;
  } finally {
    if (channelLocks.get(channelId) === settled) channelLocks.delete(channelId);
  }
}

/** Accepts `If-Match: "<version>"` (quotes optional). */
function parseIfMatch(value: string | undefined) {
  const match = /^\s*(?:W\/)?"?([a-z0-9-]{1,64})"?\s*$/i.exec(value ?? '');
  return match ? match[1] : null;
}

type CurrentProgramming = { lineup?: unknown; programs?: unknown; schedule?: unknown };

type Write =
  | { kind: 'manual'; lineup: unknown[]; keepOnAir: boolean }
  | { kind: 'schedule'; type: 'time' | 'random'; edit: unknown; seed?: number[]; discardCount?: number; extra: string[] };

function header(headers: ProxyRequest['headers'], name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isCrossOrigin(headers: ProxyRequest['headers']) {
  const origin = header(headers, 'origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const hosts = [header(headers, 'host'), header(headers, 'x-forwarded-host')]
    .flatMap((value) => (value ? value.split(',') : []))
    .map((value) => value.trim());
  return !hosts.includes(originHost);
}

export function validateLineupRange(params: URLSearchParams): { from: string; to: string } | { error: string } {
  for (const key of params.keys()) {
    if (key !== 'from' && key !== 'to') return { error: `Unsupported query parameter "${key.slice(0, 40)}".` };
  }
  if (params.getAll('from').length !== 1 || params.getAll('to').length !== 1) {
    return { error: 'Provide exactly one "from" and one "to" ISO date-time.' };
  }
  const rawFrom = params.get('from')!;
  const rawTo = params.get('to')!;
  if (!ISO_DATETIME.test(rawFrom) || !ISO_DATETIME.test(rawTo)) {
    return { error: '"from" and "to" must be ISO 8601 date-times, e.g. 2026-10-02T00:00:00.000Z.' };
  }
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: '"from" or "to" is not a real date.' };
  if (to.getTime() <= from.getTime()) return { error: '"to" must be later than "from".' };
  if (to.getTime() - from.getTime() > MAX_LINEUP_RANGE_MS) return { error: 'Date range is limited to 14 days.' };
  return { from: from.toISOString(), to: to.toISOString() };
}

export function validateManualProgramming(body: unknown): { lineup: unknown[]; keepOnAir: boolean } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const request = body as Record<string, unknown>;
  if (request.type !== 'manual') return { error: 'Only manual programming ("type": "manual") can be saved here.' };
  if (request.append !== undefined && request.append !== false) return { error: '"append" must be false.' };
  if (request.keepOnAir !== undefined && typeof request.keepOnAir !== 'boolean') return { error: '"keepOnAir" must be true or false.' };
  if (!Array.isArray(request.lineup)) return { error: '"lineup" must be an array.' };
  if (request.lineup.length > MAX_LINEUP_ITEMS) return { error: 'Lineup is too large.' };
  for (const [index, item] of request.lineup.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `Lineup item ${index} must be an object.` };
    const entry = item as Record<string, unknown>;
    if (typeof entry.type !== 'string' || !LINEUP_ITEM_TYPES.has(entry.type)) {
      return { error: `Lineup item ${index} has an unsupported type.` };
    }
    if (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration <= 0) {
      return { error: `Lineup item ${index} needs a positive duration.` };
    }
    if (ITEM_ID_REQUIRED.has(entry.type) && (typeof entry.id !== 'string' || !entry.id)) {
      return { error: `Lineup item ${index} is missing its program id.` };
    }
    if (entry.type === 'redirect' && typeof entry.channel !== 'string') {
      return { error: `Lineup item ${index} is missing its redirect channel.` };
    }
  }
  return { lineup: request.lineup, keepOnAir: request.keepOnAir === true };
}

/** Fetches program artwork through Tunarr. Only image bytes are passed on. */
async function fetchArtwork(config: ProxyConfig, target: TunarrTarget, programId: string, artworkType: string): Promise<ProxyResponse> {
  const fallback = ARTWORK_TYPES.filter((type) => type !== artworkType).join(',');
  const query = new URLSearchParams({ fallbackArtworkTypes: fallback });
  const { response, bytes } = await fetchUpstream(config, target, 'GET', `/api/programs/${programId}/artwork/${artworkType}?${query}`, {
    accept: 'image/*',
    notFound: 'Tunarr has no artwork for this program.',
  });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!IMAGE_TYPE.test(contentType)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned artwork that is not an image.');
  if (bytes.byteLength > MAX_ARTWORK_BYTES) throw new UpstreamError(502, 'artwork_too_large', 'Artwork is too large to show.');
  return {
    status: 200,
    headers: {
      'content-type': contentType.toLowerCase(),
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
    body: bytes,
  };
}

function notConfigured(config: ProxyConfig) {
  return config.configError
    ? { code: 'invalid_config', message: config.configError }
    : { code: 'not_configured', message: 'TUNARR_URL is not set on the Lineup server.' };
}

/** Library, list and channel-settings routes (content.ts) and Tunarr setup routes (admin.ts). */
async function handleContent(request: ProxyRequest, config: ProxyConfig, url: URL, method: string, route: ContentRoute | AdminRoute | LineupRoute, kind: 'content' | 'admin' | 'lineup'): Promise<ProxyResponse> {
  if (!route.methods.includes(method)) {
    return fail(405, 'method_not_allowed', `${method.slice(0, 10)} is not allowed on this route.`, {}, { allow: route.methods.join(', ') });
  }
  if (isCrossOrigin(request.headers)) return fail(403, 'cross_origin_blocked', 'Requests must come from this app.');
  if ([...url.searchParams.keys()].length) return fail(400, 'invalid_query', 'This route does not accept query parameters.');
  let body: unknown;
  if (method === 'POST' || method === 'PUT') {
    if (!/^application\/json\b/i.test(header(request.headers, 'content-type') ?? '')) return fail(415, 'unsupported_media_type', 'Send JSON.');
    try {
      body = JSON.parse(request.body ?? '');
    } catch {
      return fail(400, 'invalid_json', 'Request body is not valid JSON.');
    }
  }
  const target = config.target;
  // Saved templates and the AI status are Lineup's own; everything else reads Tunarr.
  const needsTunarr = kind !== 'lineup' || route.name === 'ai-template';
  if (!target && needsTunarr) {
    const error = notConfigured(config);
    return fail(503, error.code, error.message);
  }
  try {
    if (kind === 'lineup') return await handleLineupRoute(route as LineupRoute, { config, target, method, body });
    const context = { config, target: target!, method, body, withChannelLock };
    return kind === 'admin' ? await handleAdminRoute(route as AdminRoute, context) : await handleContentRoute(route as ContentRoute, context);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    return fail(error.status, error.code, error.message, target ? { tunarrHost: target.host } : {});
  }
}

export async function handleTunarrApi(request: ProxyRequest, config: ProxyConfig): Promise<ProxyResponse> {
  try {
    const url = new URL(request.url, 'http://companion.invalid');
    const method = request.method.toUpperCase();
    if (url.pathname.startsWith(`${API_PREFIX}/`)) {
      const subpath = url.pathname.slice(API_PREFIX.length);
      const lineup = matchLineupRoute(subpath);
      if (lineup && 'invalid' in lineup) return fail(400, 'invalid_parameter', lineup.invalid);
      if (lineup) return await handleContent(request, config, url, method, lineup, 'lineup');
      const admin = matchAdminRoute(subpath, CHANNEL_ID);
      if (admin && 'invalid' in admin) return fail(400, 'invalid_parameter', admin.invalid);
      if (admin) return await handleContent(request, config, url, method, admin, 'admin');
      const content = matchContentRoute(subpath, CHANNEL_ID);
      if (content && 'invalid' in content) return fail(400, 'invalid_parameter', content.invalid);
      if (content) return await handleContent(request, config, url, method, content, 'content');
    }
    const route = matchRoute(url.pathname);

    if (!route) return fail(404, 'route_not_allowed', 'This Tunarr route is not available through Lineup.');
    if ('invalid' in route) return fail(400, route.invalid.startsWith('Channel') ? 'invalid_channel_id' : 'invalid_parameter', route.invalid);
    if (!route.methods.includes(method)) {
      return fail(405, 'method_not_allowed', `${method.slice(0, 10)} is not allowed on this route.`, {}, { allow: route.methods.join(', ') });
    }
    if (isCrossOrigin(request.headers)) return fail(403, 'cross_origin_blocked', 'Requests must come from this app.');

    let range: { from: string; to: string } | undefined;
    if (route.name === 'lineup') {
      const checked = validateLineupRange(url.searchParams);
      if ('error' in checked) return fail(400, 'invalid_query', checked.error);
      range = checked;
    } else if (route.name === 'logo') {
      // Only a cache-busting version, so a changed logo shows up right away.
      const keys = [...url.searchParams.keys()];
      if (keys.some((key) => key !== 'v') || keys.length > 1 || !/^[a-z0-9]{0,16}$/i.test(url.searchParams.get('v') ?? '')) {
        return fail(400, 'invalid_query', 'This route only accepts a "v" parameter.');
      }
    } else if ([...url.searchParams.keys()].length) {
      return fail(400, 'invalid_query', 'This route does not accept query parameters.');
    }

    let write: Write | undefined;
    let expectedVersion: string | null = null;
    let previewEdit: unknown;
    if (method === 'POST') {
      const contentType = header(request.headers, 'content-type') ?? '';
      if (!/^application\/json\b/i.test(contentType)) return fail(415, 'unsupported_media_type', 'Send programming as application/json.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body ?? '');
      } catch {
        return fail(400, 'invalid_json', 'Request body is not valid JSON.');
      }
      if (route.name === 'schedule-preview') {
        previewEdit = parsed;
      } else {
        const type = (parsed as { type?: unknown } | null)?.type;
        if (type === 'time' || type === 'random') {
          const body = parsed as { schedule?: unknown; seed?: unknown; discardCount?: unknown; extraPrograms?: unknown };
          const seed = validateSeed(body.seed, body.discardCount);
          if ('error' in seed) return fail(400, 'invalid_programming', seed.error);
          const extra = validateExtraPrograms(body.extraPrograms);
          if ('error' in extra) return fail(400, 'invalid_programming', extra.error);
          write = { kind: 'schedule', type, edit: { ...(body.schedule as object), type }, ...seed, extra: extra.ids };
        } else {
          const checked = validateManualProgramming(parsed);
          if ('error' in checked) return fail(400, 'invalid_programming', checked.error);
          write = { kind: 'manual', lineup: checked.lineup, keepOnAir: checked.keepOnAir };
        }
        expectedVersion = parseIfMatch(header(request.headers, 'if-match'));
        if (!expectedVersion) return fail(428, 'precondition_required', 'Saves must say which version of the channel they replace (If-Match).');
      }
    }

    const target = config.target;
    if (!target) {
      const error = notConfigured(config);
      return route.name === 'health' ? json(503, { status: 'not_configured', error }) : fail(503, error.code, error.message);
    }

    try {
      switch (route.name) {
        case 'health': {
          const channels = await callTunarr(config, target, 'GET', '/api/channels');
          if (!Array.isArray(channels)) throw new UpstreamError(502, 'tunarr_invalid_response', `Tunarr at ${target.host} returned an unexpected channel list.`);
          return json(200, { status: 'connected', tunarrHost: target.host, channelCount: channels.length });
        }
        case 'channels': {
          const channels = await callTunarr(config, target, 'GET', '/api/channels');
          if (!Array.isArray(channels)) throw new UpstreamError(502, 'tunarr_invalid_response', `Tunarr at ${target.host} returned an unexpected channel list.`);
          return json(200, channels);
        }
        case 'programming': {
          const path = `/api/channels/${route.channelId}/programming`;
          if (!write) return json(200, await callTunarr(config, target, 'GET', path));
          const pending = write;
          return await withChannelLock(route.channelId, async () => {
            // Conditional save: Tunarr has no If-Match of its own, so check the
            // current version and write while holding this channel's lock.
            const current = (await callTunarr(config, target, 'GET', path)) as CurrentProgramming;
            if (programmingVersion(current?.lineup, current?.schedule) !== expectedVersion) {
              throw new UpstreamError(412, 'lineup_changed', 'This channel changed in Tunarr since it was loaded. Nothing was saved.');
            }
            let body: unknown;
            if (pending.kind === 'manual') {
              // A start-time change regenerates a slot schedule, which would discard this lineup.
              if (pending.keepOnAir && current?.schedule != null) {
                throw new UpstreamError(400, 'invalid_programming', 'This channel is generated from a slot schedule, so its start time can’t move. Save without keeping what’s on air in place.');
              }
              body = { type: 'manual', lineup: pending.lineup, append: false };
            } else {
              // Creating, converting or editing: buildSchedule keeps the current
              // schedule's other fields when the type is unchanged.
              const built = buildSchedule(current?.schedule, pending.edit);
              if ('error' in built) throw new UpstreamError(400, 'invalid_schedule', built.error);
              const programs = programPool(built.schedule.slots as Array<Record<string, unknown>>, current?.lineup, current?.programs, pending.extra);
              body = { type: pending.type, schedule: built.schedule, programs, seed: pending.seed, discardCount: pending.discardCount };
            }
            const saved = await callTunarr(config, target, 'POST', path, JSON.stringify(body));
            if (pending.kind !== 'manual' || !pending.keepOnAir) return json(200, saved);
            // Keep the pass on air in place: move the start time by what every
            // earlier pass gained or lost. The lineup is saved first, so a failure
            // here leaves an ordinary save, and the reply says so.
            try {
              const channelPath = `/api/channels/${route.channelId}`;
              const channel = await callTunarr(config, target, 'GET', channelPath);
              if (!channel || typeof channel !== 'object' || typeof (channel as { startTime?: unknown }).startTime !== 'number') {
                throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
              }
              const from = (channel as { startTime: number }).startTime;
              const startTime = keptStartTime(from, lineupLength(current?.lineup), lineupLength(pending.lineup), Date.now());
              if (startTime !== from) {
                const next: Record<string, unknown> = { ...(channel as Record<string, unknown>), startTime };
                for (const field of NOT_SAVEABLE) delete next[field];
                await callTunarr(config, target, 'PUT', channelPath, JSON.stringify(next));
              }
              return json(200, { ...(saved as object), startTime });
            } catch (error) {
              const message = error instanceof UpstreamError ? error.message : 'Tunarr did not accept the new start time.';
              return json(200, { ...(saved as object), startTimeError: `The lineup was saved, but the start time didn’t move: ${message}` });
            }
          });
        }
        case 'schedule':
          return json(200, await callTunarr(config, target, 'GET', `/api/channels/${route.channelId}/schedule`));
        case 'schedule-preview': {
          const current = (await callTunarr(config, target, 'GET', `/api/channels/${route.channelId}/programming`)) as CurrentProgramming;
          const built = buildSchedule(current?.schedule, previewEdit);
          if ('error' in built) throw new UpstreamError(400, 'invalid_schedule', built.error);
          const endpoint = built.schedule.type === 'time' ? 'schedule-time-slots' : 'schedule-slots';
          // A POST, so generation gets the longer save timeout.
          return json(200, await callTunarr(config, target, 'POST', `/api/channels/${route.channelId}/${endpoint}`, JSON.stringify({ schedule: built.schedule })));
        }
        case 'lineup': {
          const query = new URLSearchParams({ from: range!.from, to: range!.to });
          return json(200, await callTunarr(config, target, 'GET', `/api/channels/${route.channelId}/lineup?${query}`));
        }
        case 'artwork':
          return await fetchArtwork(config, target, route.programId, route.artworkType);
        case 'logo':
          try {
            return await channelLogo(config, target, route.channelId);
          } catch (error) {
            // No usable logo is normal; answer "nothing here" rather than an error.
            if (error instanceof UpstreamError && error.status === 404) return { status: 204, headers: { 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' }, body: '' };
            throw error;
          }
      }
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      if (route.name === 'health') {
        return json(error.status, { status: 'unreachable', tunarrHost: target.host, error: { code: error.code, message: error.message } });
      }
      return fail(error.status, error.code, error.message, { tunarrHost: target.host });
    }
  } catch (error) {
    console.error('[tunarr-proxy] unexpected error:', error instanceof Error ? error.message : error);
    return fail(500, 'internal_error', 'Unexpected server error.');
  }
}
