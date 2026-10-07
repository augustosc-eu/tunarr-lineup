import type { IncomingMessage, ServerResponse } from 'node:http';
import { StoreError } from './jsonFile.js';
import { matchLineupRoute } from './lineupRoutes.js';
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
  // A 204 carries no body and no Content-Length.
  if (status === 204) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, 'content-length': String(payload.byteLength) });
  res.end(payload);
}

const MEDIA_PREFIX = `${API_PREFIX}/media-folder/`;
const UPLOAD_TYPE = /^(application\/octet-stream|video\/[a-z0-9.+-]+)$/i;

export type UploadPlan = { media: MediaFolder; role: FillerRole; file: string; length: number };

/** Checks an upload (PUT /api/tunarr/media-folder/:role/:file) before any of its body is read. */
export function planUpload(url: string, headers: IncomingMessage['headers'], config: ProxyConfig): UploadPlan | ProxyResponse {
  const media = config.mediaFolder;
  if (!media || 'off' in media) return fail(503, 'media_folder_off', media && 'off' in media ? media.off : 'The media folder is off. Set LINEUP_MEDIA_DIR on the Lineup server to upload files.');
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
    if (res.destroyed || req.destroyed) return;
    const failure = error instanceof StoreError ? fail(error.status, error.code, error.message) : fail(500, 'internal_error', 'The file could not be saved.');
    reply(failure, true);
  }
}

/** Adapts Node's http request/response to the framework-free proxy handler. */
export async function handleNodeApiRequest(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const method = req.method ?? 'GET';
  if (method === 'PUT' && (req.url ?? '').startsWith(MEDIA_PREFIX)) return handleUpload(req, res, config);
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
      },
      body,
    },
    config,
  );
  send(res, result.status, result.headers, result.body);
}
