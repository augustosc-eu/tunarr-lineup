import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PREFIX, handleTunarrApi, type ProxyConfig } from './tunarrProxy.js';

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

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string) {
  res.writeHead(status, headers);
  res.end(body);
}

/** Adapts Node's http request/response to the framework-free proxy handler. */
export async function handleNodeApiRequest(req: IncomingMessage, res: ServerResponse, config: ProxyConfig) {
  const method = req.method ?? 'GET';
  let body: string | undefined;
  if (method === 'POST') {
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
      },
      body,
    },
    config,
  );
  send(res, result.status, result.headers, result.body);
}
