// Watching routes (owner decision 2026-10-19): the guide for every channel at
// once, how many people are watching each channel, and a channel's live
// stream. Each is an explicit route with validated ids; Tunarr's replies are
// reduced to what the desk shows (no viewer IPs or user agents), and stream
// playlists are rewritten so every address in them points back at this
// companion. A playlist that names anything else is refused, not passed on.
import { redirectEdges, type Call } from './recreateChannel.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, fetchUpstream, json, UpstreamError } from './upstream.js';

export const MAX_GUIDE_RANGE_MS = 24 * 3_600_000;
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const STREAM_TIMEOUT_MS = 30_000;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** One HLS file: Tunarr names them stream.m3u8 and data000123.ts. */
export const STREAM_FILE = /^[A-Za-z0-9_-]{1,64}\.(m3u8|ts|m4s|mp4|aac|vtt)$/;
const PLAYLIST_TYPE = /^(application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|audio\/x-mpegurl)$/i;
const SEGMENT_TYPE = /^(video\/mp2t|video\/mp4|video\/iso\.segment|audio\/aac|audio\/mp4|text\/vtt|application\/octet-stream)$/i;

export type WatchRoute =
  | { name: 'guide' }
  | { name: 'sessions' }
  | { name: 'redirects' }
  | { name: 'stream'; channelId: string }
  | { name: 'stream-file'; channelId: string; file: string };

export function matchWatchRoute(path: string, channelId: RegExp): WatchRoute | { invalid: string } | null {
  if (path === '/guide') return { name: 'guide' };
  if (path === '/sessions') return { name: 'sessions' };
  if (path === '/redirects') return { name: 'redirects' };
  const stream = /^\/channels\/([^/]+)\/(stream\.m3u8|hls\/([^/]+))$/.exec(path);
  if (!stream) return null;
  if (!channelId.test(stream[1])) return { invalid: 'Channel id is not valid.' };
  if (stream[2] === 'stream.m3u8') return { name: 'stream', channelId: stream[1] };
  return STREAM_FILE.test(stream[3]) ? { name: 'stream-file', channelId: stream[1], file: stream[3] } : { invalid: 'Stream file name is not valid.' };
}

export function validateGuideRange(params: URLSearchParams): { from: string; to: string } | { error: string } {
  for (const key of params.keys()) if (key !== 'from' && key !== 'to') return { error: `Unsupported query parameter "${key.slice(0, 40)}".` };
  const rawFrom = params.get('from') ?? '';
  const rawTo = params.get('to') ?? '';
  if (params.getAll('from').length !== 1 || params.getAll('to').length !== 1 || !ISO_DATETIME.test(rawFrom) || !ISO_DATETIME.test(rawTo)) {
    return { error: 'Provide one "from" and one "to" ISO 8601 date-time.' };
  }
  const from = new Date(rawFrom).getTime();
  const to = new Date(rawTo).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { error: '"to" must be later than "from".' };
  if (to - from > MAX_GUIDE_RANGE_MS) return { error: 'The guide grid shows up to 24 hours at a time.' };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : undefined);

export type GuideEntry = { start: number; stop: number; type: string; title: string; detail: string; id?: string; fillerListId?: string; redirectTo?: string };
export type GuideChannel = { id: string; number: number; name: string; programs: GuideEntry[] };

/** One guide entry as the grid shows it: a title and a line of detail, nothing else. */
export function guideEntry(raw: Json): GuideEntry | null {
  if (typeof raw.start !== 'number' || typeof raw.stop !== 'number' || raw.stop <= raw.start || typeof raw.type !== 'string') return null;
  const program = isObject(raw.program) ? raw.program : {};
  const type = raw.type;
  let title = text(raw.title) ?? text(program.title) ?? '';
  let detail = '';
  if (program.type === 'episode') {
    const show = isObject(program.show) ? text(program.show.title) : isObject(program.season) && isObject(program.season.show) ? text(program.season.show.title) : undefined;
    const season = typeof program.seasonNumber === 'number' ? program.seasonNumber : isObject(program.season) && typeof program.season.index === 'number' ? program.season.index : undefined;
    const episode = typeof program.episodeNumber === 'number' ? program.episodeNumber : undefined;
    detail = `${season != null && episode != null ? `S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')} · ` : ''}${text(program.title) ?? ''}`;
    title = show ?? title;
  } else if (program.type === 'track') {
    title = text(program.artistName) ?? title;
    detail = text(program.title) ?? '';
  } else if (typeof program.year === 'number') detail = String(program.year);
  if (type === 'flex') title ||= 'Flex time';
  if (type === 'redirect') {
    title = text(raw.channelName) ?? (title || 'Channel redirect');
    detail = typeof raw.channelNumber === 'number' ? `Redirect to CH ${raw.channelNumber}` : 'Redirect';
  }
  return {
    start: raw.start, stop: raw.stop, type, title: title || 'Untitled program', detail,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
    ...(typeof raw.fillerListId === 'string' ? { fillerListId: raw.fillerListId } : {}),
    ...(typeof raw.channel === 'string' ? { redirectTo: raw.channel } : {}),
  };
}

/** Tunarr's all-channel guide (`/api/guide/channels`) reduced for the grid. */
export function slimGuide(raw: unknown): GuideChannel[] {
  const channels = isObject(raw) ? Object.values(raw) : Array.isArray(raw) ? raw : [];
  return channels.filter(isObject).flatMap((channel) => {
    if (typeof channel.id !== 'string' || typeof channel.number !== 'number') return [];
    const programs = (Array.isArray(channel.programs) ? channel.programs : []).filter(isObject).map(guideEntry).filter((entry): entry is GuideEntry => !!entry).sort((a, b) => a.start - b.start);
    return [{ id: channel.id, number: channel.number, name: text(channel.name, 120) ?? '', programs }];
  }).sort((a, b) => a.number - b.number);
}

/** Viewers per channel from Tunarr's sessions: counts only, never who is watching. */
export function viewerCounts(raw: unknown, channelId: RegExp): Record<string, { viewers: number; streams: number }> {
  const out: Record<string, { viewers: number; streams: number }> = {};
  if (!isObject(raw)) return out;
  for (const [id, sessions] of Object.entries(raw)) {
    if (!channelId.test(id) || !Array.isArray(sessions)) continue;
    const live = sessions.filter((session) => isObject(session) && session.state !== 'stopped' && session.state !== 'error');
    const viewers = live.reduce((sum: number, session) => sum + (typeof (session as Json).numConnections === 'number' ? Math.max(0, Math.floor((session as Json).numConnections as number)) : 0), 0);
    if (live.length) out[id] = { viewers, streams: live.length };
  }
  return out;
}

/**
 * Points every address in a Tunarr HLS playlist back at this companion. Only
 * this channel's own playlist and HLS files are allowed; anything else (another
 * host, another channel, an unexpected path) makes the whole playlist invalid.
 */
export function rewritePlaylist(playlist: string, base: URL, target: TunarrTarget, channelId: string): string | null {
  const prefix = `${target.basePath}/stream/channels/`;
  const local = (uri: string) => {
    let url: URL;
    try {
      url = new URL(uri, base);
    } catch {
      return null;
    }
    if (url.origin !== target.origin || !url.pathname.startsWith(prefix)) return null;
    const rest = url.pathname.slice(prefix.length);
    const file = /^([^/]+)\/hls\/([^/]+)$/.exec(rest);
    if (file && file[1].toLowerCase() === channelId.toLowerCase() && STREAM_FILE.test(file[2])) return `/api/tunarr/channels/${channelId}/hls/${file[2]}`;
    if (rest.toLowerCase() === `${channelId.toLowerCase()}.m3u8`) return `/api/tunarr/channels/${channelId}/stream.m3u8`;
    return null;
  };
  const lines: string[] = [];
  for (const line of playlist.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { lines.push(''); continue; }
    if (trimmed.startsWith('#')) {
      // Tags can carry addresses too (EXT-X-MAP, EXT-X-MEDIA, EXT-X-KEY…).
      let bad = false;
      const rewritten = trimmed.replace(/URI="([^"]*)"/g, (_whole, uri: string) => {
        const next = local(uri);
        if (!next) bad = true;
        return `URI="${next ?? ''}"`;
      });
      if (bad) return null;
      lines.push(rewritten);
      continue;
    }
    const next = local(trimmed);
    if (!next) return null;
    lines.push(next);
  }
  return lines.join('\n');
}

const streamHeaders = (contentType: string) => ({
  'content-type': contentType,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
});

async function streamFile(config: ProxyConfig, target: TunarrTarget, channelId: string, upstreamPath: string): Promise<ProxyResponse> {
  const { response, bytes } = await fetchUpstream(config, target, 'GET', upstreamPath, { accept: '*/*', notFound: 'Tunarr has no stream for this channel right now.', timeoutMs: STREAM_TIMEOUT_MS });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (bytes.byteLength > MAX_STREAM_BYTES) throw new UpstreamError(502, 'stream_too_large', 'Tunarr sent a stream part that is too large.');
  if (PLAYLIST_TYPE.test(contentType) || upstreamPath.split('?')[0].endsWith('.m3u8')) {
    const base = new URL(`${target.origin}${target.basePath}${upstreamPath}`);
    const rewritten = rewritePlaylist(new TextDecoder().decode(bytes), base, target, channelId);
    if (rewritten === null) throw new UpstreamError(502, 'stream_unexpected', 'Tunarr’s stream playlist points somewhere Lineup doesn’t pass on.');
    return { status: 200, headers: streamHeaders('application/vnd.apple.mpegurl'), body: rewritten };
  }
  if (!SEGMENT_TYPE.test(contentType)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr sent a stream part of an unexpected type.');
  return { status: 200, headers: streamHeaders(contentType), body: bytes };
}

export async function handleWatchRoute(route: WatchRoute, config: ProxyConfig, target: TunarrTarget, url: URL, channelId: RegExp): Promise<ProxyResponse> {
  switch (route.name) {
    case 'guide': {
      const range = validateGuideRange(url.searchParams);
      if ('error' in range) return fail(400, 'invalid_query', range.error);
      const query = new URLSearchParams({ dateFrom: range.from, dateTo: range.to });
      // The all-channel guide carries full program metadata; it can be several MB.
      const raw = await callTunarr(config, target, 'GET', `/api/guide/channels?${query}`);
      return json(200, { from: range.from, to: range.to, channels: slimGuide(raw) });
    }
    case 'sessions':
      return json(200, viewerCounts(await callTunarr(config, target, 'GET', '/api/sessions'), channelId));
    case 'redirects': {
      if ([...url.searchParams.keys()].length) return fail(400, 'invalid_query', 'This route does not accept query parameters.');
      const call: Call = (method, path, body) => callTunarr(config, target, method, path, body === undefined ? undefined : JSON.stringify(body));
      return json(200, { edges: await redirectEdges(call) });
    }
    case 'stream':
      // Always HLS, whatever the channel's own stream mode: it's what a browser can play.
      return streamFile(config, target, route.channelId, `/stream/channels/${route.channelId}.m3u8?mode=hls`);
    case 'stream-file':
      return streamFile(config, target, route.channelId, `/stream/channels/${route.channelId}/hls/${route.file}`);
  }
}
