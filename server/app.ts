// Local companion HTTP app: serves the built Lineup interface and the narrow
// /api/tunarr/* proxy from one origin, so the browser never contacts Tunarr.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { AUTH_CHALLENGE, isAuthorized, type AuthConfig } from './auth.js';
import { handleNodeApiRequest, isTunarrApiPath } from './nodeAdapter.js';
import type { ProxyConfig } from './tunarrProxy.js';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The page may only talk to its own origin; this also blocks any accidental
// direct request to Tunarr from the browser.
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

async function resolveStatic(staticRoot: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const filePath = path.resolve(staticRoot, `.${path.posix.normalize(decoded)}`);
  if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${path.sep}`)) return null;
  try {
    const info = await stat(filePath);
    return info.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

function sendFile(res: http.ServerResponse, filePath: string, method: string, immutable: boolean) {
  res.writeHead(200, {
    ...securityHeaders,
    'content-type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

export function createLineupServer({ config, auth, staticRoot }: { config: ProxyConfig; auth: AuthConfig; staticRoot: string }) {
    return http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const pathname = (req.url ?? '/').split('?')[0];

      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (!isAuthorized(req.headers.authorization, auth)) {
        res.writeHead(401, { ...AUTH_CHALLENGE, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Sign in to Tunarr Lineup.');
        return;
      }
      if (isTunarrApiPath(req.url)) {
        await handleNodeApiRequest(req, res, config);
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const file = pathname === '/' ? null : await resolveStatic(staticRoot, pathname);
      if (file) {
        sendFile(res, file, method, pathname.startsWith('/assets/'));
        return;
      }
      if (path.extname(pathname)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const index = await resolveStatic(staticRoot, '/index.html');
      if (!index) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Lineup interface is not built. Run "npm run build:local".');
        return;
      }
      sendFile(res, index, method, false);
    } catch (error) {
      console.error('[server] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  });
}
