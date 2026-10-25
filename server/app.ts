// Local companion HTTP app: serves the built Lineup interface and the narrow
// /api/tunarr/* proxy from one origin, so the browser never contacts Tunarr.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { AUTH_CHALLENGE, authorize, type AuthConfig } from './auth.js';
import { compress, isCompressible, pickEncoding, type Encoding } from './compression.js';
import { hostRefusal, isAllowedHost, type HostPolicy } from './hosts.js';
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The page may only talk to its own origin; this also blocks any accidental
// direct request to Tunarr from the browser.
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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

// The interface's script and stylesheet compressed once per build (keyed by
// path, size and modification time), since they are most of a first visit.
const compressedFiles = new Map<string, { key: string; data: Buffer }>();

async function compressedFile(filePath: string, encoding: Encoding) {
  const info = await stat(filePath);
  const key = `${info.size}:${info.mtimeMs}`;
  const cached = compressedFiles.get(`${encoding}:${filePath}`);
  if (cached?.key === key) return cached.data;
  const data = await compress(await readFile(filePath), encoding);
  compressedFiles.set(`${encoding}:${filePath}`, { key, data });
  return data;
}

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string, immutable: boolean, compression: boolean) {
  const contentType = mimeTypes[path.extname(filePath)] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    ...securityHeaders,
    'content-type': contentType,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  const encoding = compression && isCompressible(contentType, (await stat(filePath)).size) ? pickEncoding(req.headers['accept-encoding']) : null;
  if (compression && isCompressible(contentType, Number.MAX_SAFE_INTEGER)) headers.vary = 'Accept-Encoding';
  if (encoding) {
    const data = await compressedFile(filePath, encoding);
    res.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': String(data.byteLength) });
    res.end(req.method === 'HEAD' ? undefined : data);
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

/** `auth` is the sign-in to ask for, or a function giving the current one (it changes when setup is done). */
export function createLineupServer({ config, auth: authOption, staticRoot, hosts = { any: false, names: [] } }: { config: ProxyConfig; auth: AuthConfig | (() => AuthConfig); staticRoot: string; hosts?: HostPolicy }) {
  const currentAuth = typeof authOption === 'function' ? authOption : () => authOption;
  // Video uploads can take a while on a slow network; Node's 5-minute default would cut them off.
  // A server set up from the desk may get a media folder later.
  return http.createServer({ requestTimeout: config.mediaFolder || config.setup ? 4 * 3_600_000 : 300_000 }, async (req, res) => {
    try {
      const auth = currentAuth();
      const method = req.method ?? 'GET';
      const pathname = (req.url ?? '/').split('?')[0];

      if (pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      // Without sign-in, refuse unknown host names (DNS rebinding; see hosts.ts). Before setup
      // only the setup-code routes answer, and a rebound page can't know the code.
      if (!auth && !config.setup?.needed() && !isAllowedHost(req.headers.host, hosts)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(hostRefusal(req.headers.host ?? ''));
        return;
      }
      if (!(await authorize(req.headers.authorization, auth))) {
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
        await sendFile(req, res, file, pathname.startsWith('/assets/'), config.compression !== false);
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
      await sendFile(req, res, index, false, config.compression !== false);
    } catch (error) {
      console.error('[server] request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  });
}
