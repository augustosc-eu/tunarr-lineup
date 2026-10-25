import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { compress, isCompressible, pickEncoding } from './compression.js';
import { StoreError } from './jsonFile.js';
import { matchLineupRoute } from './lineupRoutes.js';
import { setupRequired } from './setup.js';
import type { FillerRole } from './fillerRoles.js';
import type { MediaFolder } from './mediaFolder.js';
import { API_PREFIX, handleTunarrApi, isCrossOrigin, type ProxyConfig, type ProxyResponse } from './tunarrProxy.js';
import { fail, json } from './upstream.js';

export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function isTunarrApiPath(url: string | undefined) {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Uint8Array) {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  // A 204 or 304 carries no body and no Content-Length.
  if (status === 204 || status === 304) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, 'content-length': String(payload.byteLength) });
  res.end(payload);
}

/** Like `send`, compressed when the browser accepts it and the body is JSON or text worth compressing. */
async function sendCompressed(req: IncomingMessage, res: ServerResponse, config: ProxyConfig, result: ProxyResponse) {
  const size = typeof result.body === 'string' ? Buffer.byteLength(result.body) : result.body.byteLength;
  const encoding = config.compression === false || result.status === 204 || result.status === 304 || result.headers['content-encoding'] ? null : pickEncoding(req.headers['accept-encoding']);
  if (!encoding || !isCompressible(result.headers['content-type'], size)) return send(res, result.status, result.headers, result.body);
  const raw = typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength);
  send(res, result.status, { ...result.headers, 'content-encoding': encoding, vary: 'Accept-Encoding' }, await compress(raw, encoding));
}

const MEDIA_PREFIX = `${API_PREFIX}/media-folder/`;
const UPLOAD_TYPE = /^(application\/octet-stream|video\/[a-z0-9.+-]+)$/i;

export type UploadPlan = { media: MediaFolder; role: FillerRole; file: string; length: number };

/** Checks an upload (PUT /api/tunarr/media-folder/:role/:file) before any of its body is read. */
export function planUpload(url: string, headers: IncomingMessage['headers'], config: ProxyConfig): UploadPlan | ProxyResponse {
  const media = config.mediaFolder;
  if (!media || 'off' in media) return fail(503, 'media_folder_off', media && 'off' in media ? media.off : 'The media folder is off. Choose one under Setup → Server Settings to upload files.');
  if (isCrossOrigin({ host: headers.host, origin: headers.origin, 'x-forwarded-host': headers['x-forwarded-host'] })) return fail(403, 'cross_origin_blocked', 'Requests must come from this app.');
  const [pathname, query] = url.split('?');
  if (query !== undefined) return fail(400, 'invalid_query', 'This route does not accept query parameters.');
  const route = matchLineupRoute(pathname.slice(API_PREFIX.length));
  if (route && 'invalid' in route) return fail(400, 'invalid_parameter', route.invalid);
  if (!route || route.name !== 'media-file') return fail(405, 'method_not_allowed', 'PUT is not allowed on this route.');
  const type = (headers['content-type'] ?? '').split(';')[0].trim();
  if (!UPLOAD_TYPE.test(type)) return fail(415, 'unsupported_media_type', 'Send the video file itself (application/octet-stream or video/*).');
  const raw = headers['content-length'];
  if (headers['transfer-encoding'] || raw === undefined || !/^\d{1,15}$/.test(raw)) return fail(411, 'length_required', 'Uploads must say how large the file is (Content-Length).');
  const length = Number(raw);
  if (length < 1) return fail(400, 'invalid_request', 'The file is empty.');
  if (length > media.maxBytes) return fail(413, 'file_too_large', `Files can be up to ${Math.round(media.maxBytes / 1024 / 1024)} MB (LINEUP_MEDIA_MAX_MB).`);
  return { media, role: route.role, file: route.file, length };
}

/** Streams one upload into the media folder. Refusals close the connection so an unread body isn't waited for. */
async function handleUpload(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const reply = (result: ProxyResponse, close: boolean) => send(res, result.status, close ? { ...result.headers, connection: 'close' } : result.headers, result.body);
  const plan = planUpload(req.url ?? '/', req.headers, config);
  if (!('media' in plan)) return reply(plan, true);
  try {
    const saved = await plan.media.save(plan.role, plan.file, req, plan.length);
    reply(json(201, { role: plan.role, ...saved }), false);
  } catch (error) {
    // A stream error has already closed the socket; there is no one left to answer.
    if (res.destroyed) return;
    const failure = error instanceof StoreError ? fail(error.status, error.code, error.message) : fail(500, 'internal_error', 'The file could not be saved.');
    reply(failure, true);
  }
}

const PLAYBACK_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
};

/** One `bytes=a-b` range within a file of `size` bytes, or null for anything else (then the whole file is sent). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    // A suffix: the last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

/**
 * Plays back a video from the media folder (GET /api/tunarr/media-folder/:role/:file),
 * so a filler clip can be watched before it's tagged. Streamed with byte ranges
 * for seeking; only files that pass `mediaFileName` in a role folder.
 */
async function handlePlayback(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const reply = (result: ProxyResponse) => send(res, result.status, result.headers, result.body);
  const media = config.mediaFolder;
  if (!media || 'off' in media) return reply(fail(503, 'media_folder_off', media && 'off' in media ? media.off : 'The media folder is off.'));
  if (isCrossOrigin({ host: req.headers.host, origin: req.headers.origin, 'x-forwarded-host': req.headers['x-forwarded-host'] })) return reply(fail(403, 'cross_origin_blocked', 'Requests must come from this app.'));
  const [pathname, query] = (req.url ?? '/').split('?');
  if (query !== undefined) return reply(fail(400, 'invalid_query', 'This route does not accept query parameters.'));
  const route = matchLineupRoute(pathname.slice(API_PREFIX.length));
  if (route && 'invalid' in route) return reply(fail(400, 'invalid_parameter', route.invalid));
  if (!route || route.name !== 'media-file') return reply(fail(405, 'method_not_allowed', 'Only files can be played.'));
  let file: { path: string; size: number };
  try {
    file = await media.open(route.role, route.file);
  } catch (error) {
    return reply(error instanceof StoreError ? fail(error.status, error.code, error.message) : fail(500, 'internal_error', 'The file could not be read.'));
  }
  const headers: Record<string, string> = {
    'content-type': PLAYBACK_TYPES[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  };
  const range = parseRange(req.headers.range, file.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  res.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(Math.max(0, end - start + 1)), ...(range ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}) });
  if (req.method === 'HEAD' || file.size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file.path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Adapts Node's http request/response to the framework-free proxy handler. */
export async function handleNodeApiRequest(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const method = req.method ?? 'GET';
  // Uploads and playback skip the proxy below, so the setup gate is repeated here.
  if (config.setup?.needed() && (req.url ?? '').startsWith(MEDIA_PREFIX)) {
    const result = setupRequired(false);
    send(res, result.status, result.headers, result.body);
    return;
  }
  if (method === 'PUT' && (req.url ?? '').startsWith(MEDIA_PREFIX)) return handleUpload(req, res, config);
  // Playing a media-folder file back; /move and the folder listing go to the proxy as usual.
  if ((method === 'GET' || method === 'HEAD') && (req.url ?? '').startsWith(MEDIA_PREFIX) && !(req.url ?? '').split('?')[0].endsWith('/move')) return handlePlayback(req, res, config);
  let body: string | undefined;
  if (method === 'POST' || method === 'PUT') {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      send(res, 413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify({ error: { code: 'payload_too_large', message: 'Request body is too large.' } }));
      return;
    }
    body = raw;
  }
  // Only the headers the proxy needs are passed on; cookies and auth headers
  // from the browser are never forwarded upstream.
  const result = await handleTunarrApi(
    {
      method,
      url: req.url ?? '/',
      headers: {
        host: req.headers.host,
        origin: req.headers.origin,
        'x-forwarded-host': req.headers['x-forwarded-host'],
        'content-type': req.headers['content-type'],
        'if-match': req.headers['if-match'],
        'if-none-match': req.headers['if-none-match'],
      },
      body,
    },
    config,
  );
  // The browser may have gone (a channel switch aborts the old request); there's no one to answer.
  if (res.destroyed) return;
  await sendCompressed(req, res, config, result);
}
