// Channel logos. Tunarr stores a logo as a URL: usually its own
// /images/uploads/… file (saved under whatever host name was used at upload
// time), sometimes an image on a public site. The browser only ever asks
// Lineup for /api/tunarr/channels/:id/logo; Lineup fetches Tunarr-hosted logos
// from TUNARR_URL and public ones through a guarded fetch that refuses private
// and local addresses.
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fetchUpstream, UpstreamError } from './upstream.js';

export const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const LOGO_TYPE = /^image\/(jpeg|png|webp|gif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
const SAFE_IMAGE_PATH = /^\/images\/[A-Za-z0-9._~!$&'()*+,;=:@%/ -]+$/;
const CACHE_TTL_MS = 60 * 60_000;
const MISS_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 400;

export type ExternalImage = { contentType: string; bytes: Uint8Array };
export type ExternalImageFetcher = (url: URL) => Promise<ExternalImage>;
export type LogoSource = { kind: 'tunarr'; path: string; fallback?: URL } | { kind: 'external'; url: URL };

/** Where to load a stored logo URL from, or null if there is nothing usable. */
export function logoSource(raw: unknown, target: TunarrTarget): LogoSource | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return null;
  const value = raw.trim();
  const tunarrPath = (path: string) => {
    // Refuse anything that could climb out of Tunarr's image folders.
    if (!SAFE_IMAGE_PATH.test(path) || /%2e|%2f|%5c|\/\.\.?(\/|$)/i.test(path)) return null;
    return path;
  };
  if (value.startsWith('/')) {
    const path = tunarrPath(value.split(/[?#]/)[0]);
    return path ? { kind: 'tunarr', path } : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // Uploaded logos keep the host they were uploaded through (localhost,
  // host.docker.internal, a tailnet name…); they all live in Tunarr's own folder.
  if (url.host === target.host || url.pathname.startsWith('/images/uploads/') || url.pathname === '/images/tunarr.png') {
    const path = tunarrPath(url.pathname);
    if (path) return { kind: 'tunarr', path, fallback: url.host === target.host ? undefined : url };
    // Never fetch Tunarr's own host as a "public" site.
    if (url.host === target.host) return null;
  }
  return { kind: 'external', url };
}

// Addresses a public logo may never resolve to: loopback, private networks,
// link-local, carrier-grade NAT (Tailscale), documentation, multicast…
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped and checked as IPv4 below. No
// ::ffff:0:0/96 rule: BlockList also matches plain IPv4 addresses against it.

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/** DNS lookup that fails unless every address is public, so the connection can't be steered inside. */
function publicLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || !addresses.every((entry) => isPublicAddress(entry.address))) {
      return callback(Object.assign(new Error('Logo host is not a public address.'), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Fetches a public image over HTTP(S). Follows up to 3 redirects, re-checking each. */
export function fetchPublicImage(url: URL, timeoutMs = 8_000, redirects = 3): Promise<ExternalImage> {
  return new Promise((resolve, reject) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('Unsupported logo URL.'));
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) return reject(new Error('Logo URL uses an unusual port.'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) ? !isPublicAddress(host) : /(^|\.)(localhost|local|internal|lan|home|ts\.net)$/i.test(host)) {
      return reject(new Error('Logo host is not public.'));
    }
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { lookup: publicLookup as never, timeout: timeoutMs, headers: { accept: 'image/*', 'user-agent': 'TunarrLineup/1' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects.'));
        let next: URL;
        try {
          next = new URL(response.headers.location, url);
        } catch {
          return reject(new Error('Bad redirect.'));
        }
        return fetchPublicImage(next, timeoutMs, redirects - 1).then(resolve, reject);
      }
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (status !== 200 || !LOGO_TYPE.test(contentType)) {
        response.resume();
        return reject(new Error(`Logo request failed (${status}).`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_LOGO_BYTES) {
          request.destroy(new Error('Logo is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ contentType, bytes: new Uint8Array(Buffer.concat(chunks)) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Logo request timed out.')));
    request.on('error', reject);
  });
}

type Cached = { at: number; image: ExternalImage | null };
const cache = new Map<string, Cached>();

function remember(key: string, image: ExternalImage | null) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), image });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

export function clearLogoCache() {
  cache.clear();
}

function imageResponse(image: ExternalImage): ProxyResponse {
  return {
    status: 200,
    headers: {
      'content-type': image.contentType,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
    body: image.bytes,
  };
}

async function loadFromTunarr(config: ProxyConfig, target: TunarrTarget, path: string): Promise<ExternalImage> {
  const { response, bytes } = await fetchUpstream(config, target, 'GET', path, { accept: 'image/*', notFound: 'Tunarr has no file for this logo.' });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!LOGO_TYPE.test(contentType)) throw new UpstreamError(502, 'tunarr_invalid_response', 'The channel logo is not an image.');
  if (bytes.byteLength > MAX_LOGO_BYTES) throw new UpstreamError(502, 'logo_too_large', 'The channel logo is too large to show.');
  return { contentType, bytes };
}

/** GET /api/tunarr/channels/:id/logo */
export async function channelLogo(config: ProxyConfig, target: TunarrTarget, channelId: string): Promise<ProxyResponse> {
  const channel = (await callTunarr(config, target, 'GET', `/api/channels/${channelId}`)) as { icon?: { path?: unknown } } | null;
  const source = logoSource(channel?.icon?.path, target);
  if (!source) throw new UpstreamError(404, 'no_logo', 'This channel has no logo.');
  const key = source.kind === 'tunarr' ? `tunarr:${source.path}` : `url:${source.url.href}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.image ? CACHE_TTL_MS : MISS_TTL_MS)) {
    if (!hit.image) throw new UpstreamError(404, 'no_logo', 'The channel logo could not be loaded.');
    return imageResponse(hit.image);
  }
  const external = config.externalLogos === false ? null : config.fetchExternalImage ?? ((url: URL) => fetchPublicImage(url));
  try {
    let image: ExternalImage;
    if (source.kind === 'tunarr') {
      try {
        image = await loadFromTunarr(config, target, source.path);
      } catch (error) {
        // An /images/uploads URL on another site, not Tunarr's: try it directly.
        if (!(error instanceof UpstreamError) || error.status !== 404 || !source.fallback || !external) throw error;
        image = await external(source.fallback);
      }
    } else {
      if (!external) throw new UpstreamError(404, 'no_logo', 'Logos from other sites are turned off (LINEUP_EXTERNAL_LOGOS=false).');
      image = await external(source.url);
    }
    remember(key, image);
    return imageResponse(image);
  } catch (error) {
    if (error instanceof UpstreamError && error.status !== 404) throw error;
    remember(key, null);
    throw error instanceof UpstreamError ? error : new UpstreamError(404, 'no_logo', 'The channel logo could not be loaded.');
  }
}
