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
  body: string;
};

export const API_PREFIX = '/api/tunarr';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_SAVE_TIMEOUT_MS = 30_000;
export const MAX_LINEUP_RANGE_MS = 14 * 24 * 3_600_000;
export const MAX_LINEUP_ITEMS = 100_000;

const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const LINEUP_ITEM_TYPES = new Set(['content', 'custom', 'filler', 'flex', 'redirect']);
const ITEM_ID_REQUIRED = new Set(['content', 'custom', 'filler']);

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
  };
}

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(status: number, data: unknown, extraHeaders: Record<string, string> = {}): ProxyResponse {
  return { status, headers: { ...jsonHeaders, ...extraHeaders }, body: JSON.stringify(data) };
}

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message, ...extra } }, headers);
}

class UpstreamError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type Route =
  | { name: 'health'; methods: string[] }
  | { name: 'channels'; methods: string[] }
  | { name: 'programming'; methods: string[]; channelId: string }
  | { name: 'lineup'; methods: string[]; channelId: string };

function matchRoute(pathname: string): Route | { invalidChannelId: true } | null {
  if (pathname === `${API_PREFIX}/health`) return { name: 'health', methods: ['GET'] };
  if (pathname === `${API_PREFIX}/channels`) return { name: 'channels', methods: ['GET'] };
  const match = /^\/api\/tunarr\/channels\/([^/]+)\/(programming|lineup)$/.exec(pathname);
  if (!match) return null;
  // Validate the raw (still percent-encoded) segment so encoded slashes or
  // dots can never reach the upstream URL.
  if (!CHANNEL_ID.test(match[1])) return { invalidChannelId: true };
  return match[2] === 'programming'
    ? { name: 'programming', methods: ['GET', 'POST'], channelId: match[1] }
    : { name: 'lineup', methods: ['GET'], channelId: match[1] };
}

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

export function validateManualProgramming(body: unknown): { lineup: unknown[] } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const request = body as Record<string, unknown>;
  if (request.type !== 'manual') return { error: 'Only manual programming ("type": "manual") can be saved here.' };
  if (request.append !== undefined && request.append !== false) return { error: '"append" must be false.' };
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
  return { lineup: request.lineup };
}

/** Keeps upstream validation text useful but bounded and single-line. */
function upstreamMessage(text: string) {
  let message = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'string') message = parsed;
    else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const candidate = record.error ?? record.message;
      if (typeof candidate === 'string') message = candidate;
    }
  } catch {
    // Plain-text body; use it as-is.
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function callTunarr(
  config: ProxyConfig,
  target: TunarrTarget,
  method: 'GET' | 'POST',
  path: string,
  body?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (target.authorization) headers.authorization = target.authorization;
  const timeoutMs = method === 'POST' ? config.saveTimeoutMs : config.timeoutMs;
  const doFetch = config.fetchImpl ?? fetch;

  let response: Response;
  let text: string;
  try {
    response = await doFetch(`${target.origin}${target.basePath}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new UpstreamError(504, 'tunarr_timeout', `Tunarr at ${target.host} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    const detail = typeof cause === 'string' && /^[A-Z_]+$/.test(cause) ? ` (${cause})` : '';
    throw new UpstreamError(502, 'tunarr_unreachable', `Could not reach Tunarr at ${target.host}${detail}.`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(502, 'tunarr_redirect', `Tunarr at ${target.host} answered with a redirect. Check TUNARR_URL.`);
  }
  if (response.status === 404) throw new UpstreamError(404, 'not_found', 'Tunarr could not find that channel.');
  if (response.status === 400) {
    throw new UpstreamError(400, 'tunarr_rejected', upstreamMessage(text) || 'Tunarr rejected the request.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError(502, 'tunarr_auth', `Tunarr at ${target.host} refused the request (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new UpstreamError(502, 'tunarr_error', `Tunarr at ${target.host} returned HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError(502, 'tunarr_invalid_response', `Tunarr at ${target.host} returned a response that is not JSON. Check TUNARR_URL.`);
  }
}

export async function handleTunarrApi(request: ProxyRequest, config: ProxyConfig): Promise<ProxyResponse> {
  try {
    const url = new URL(request.url, 'http://companion.invalid');
    const method = request.method.toUpperCase();
    const route = matchRoute(url.pathname);

    if (!route) return fail(404, 'route_not_allowed', 'This Tunarr route is not available through Lineup.');
    if ('invalidChannelId' in route) return fail(400, 'invalid_channel_id', 'Channel id is not valid.');
    if (!route.methods.includes(method)) {
      return fail(405, 'method_not_allowed', `${method.slice(0, 10)} is not allowed on this route.`, {}, { allow: route.methods.join(', ') });
    }
    if (isCrossOrigin(request.headers)) return fail(403, 'cross_origin_blocked', 'Requests must come from this app.');

    let range: { from: string; to: string } | undefined;
    if (route.name === 'lineup') {
      const checked = validateLineupRange(url.searchParams);
      if ('error' in checked) return fail(400, 'invalid_query', checked.error);
      range = checked;
    } else if ([...url.searchParams.keys()].length) {
      return fail(400, 'invalid_query', 'This route does not accept query parameters.');
    }

    let upstreamBody: string | undefined;
    if (method === 'POST') {
      const contentType = header(request.headers, 'content-type') ?? '';
      if (!/^application\/json\b/i.test(contentType)) return fail(415, 'unsupported_media_type', 'Send programming as application/json.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body ?? '');
      } catch {
        return fail(400, 'invalid_json', 'Request body is not valid JSON.');
      }
      const checked = validateManualProgramming(parsed);
      if ('error' in checked) return fail(400, 'invalid_programming', checked.error);
      upstreamBody = JSON.stringify({ type: 'manual', lineup: checked.lineup, append: false });
    }

    const target = config.target;
    if (!target) {
      const notConfigured = config.configError
        ? { code: 'invalid_config', message: config.configError }
        : { code: 'not_configured', message: 'TUNARR_URL is not set on the Lineup server.' };
      return route.name === 'health'
        ? json(503, { status: 'not_configured', error: notConfigured })
        : fail(503, notConfigured.code, notConfigured.message);
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
          return json(200, await callTunarr(config, target, method === 'POST' ? 'POST' : 'GET', path, upstreamBody));
        }
        case 'lineup': {
          const query = new URLSearchParams({ from: range!.from, to: range!.to });
          return json(200, await callTunarr(config, target, 'GET', `/api/channels/${route.channelId}/lineup?${query}`));
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
