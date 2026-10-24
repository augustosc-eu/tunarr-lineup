// Response compression with node:zlib only (invariant 7: no dependencies).
// A large channel's programming is megabytes of JSON that compresses about
// tenfold, which is most of the wait on a phone, a VPN or a tailnet.
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

export type Encoding = 'br' | 'gzip';

/** Smaller bodies aren't worth the work or the extra header. */
export const MIN_COMPRESS_BYTES = 1024;
const COMPRESSIBLE = /^(application\/(json|manifest\+json|javascript)|text\/|image\/svg\+xml)/i;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * The encoding to use for an Accept-Encoding header: Brotli when offered
 * (browsers offer it only over HTTPS), else gzip, else none. `q=0` refuses one.
 */
export function pickEncoding(header: string | string[] | undefined): Encoding | null {
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  const offered = new Map<string, number>();
  for (const part of value.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find(Boolean);
    offered.set(name, q === undefined ? 1 : Number(q));
  }
  const accepts = (name: Encoding) => (offered.get(name) ?? (offered.has('*') ? offered.get('*')! : 0)) > 0;
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

export const isCompressible = (contentType: string | undefined, size: number) => size >= MIN_COMPRESS_BYTES && COMPRESSIBLE.test(contentType ?? '');

/** Off the event loop's main thread (zlib's thread pool), so other requests keep moving. */
export function compress(body: Buffer, encoding: Encoding): Promise<Buffer> {
  // Brotli quality 4 is about as fast as gzip's default and a third smaller on JSON.
  return encoding === 'br'
    ? brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength } })
    : gzipAsync(body, { level: 6 });
}

/** False when LINEUP_COMPRESSION is off (for a reverse proxy that compresses itself). */
export const compressionEnabled = (raw: string | undefined) => !/^(off|false|0|no)$/i.test(raw?.trim() ?? '');
