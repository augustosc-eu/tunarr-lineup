// Shared plumbing for calling Tunarr: response helpers, normalized errors,
// and the single upstream fetch every proxy route goes through.
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';

export type UpstreamMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(status: number, data: unknown, extraHeaders: Record<string, string> = {}): ProxyResponse {
  return { status, headers: { ...jsonHeaders, ...extraHeaders }, body: JSON.stringify(data) };
}

export function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message, ...extra } }, headers);
}

export class UpstreamError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
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

export async function fetchUpstream(
  config: ProxyConfig,
  target: TunarrTarget,
  method: UpstreamMethod,
  path: string,
  options: { accept: string; body?: string; notFound: string },
): Promise<{ response: Response; bytes: Uint8Array }> {
  const headers: Record<string, string> = { accept: options.accept };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (target.authorization) headers.authorization = target.authorization;
  const timeoutMs = method === 'GET' ? config.timeoutMs : config.saveTimeoutMs;
  const doFetch = config.fetchImpl ?? fetch;

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await doFetch(`${target.origin}${target.basePath}${path}`, {
      method,
      headers,
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    bytes = new Uint8Array(await response.arrayBuffer());
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
  if (response.status === 404) throw new UpstreamError(404, 'not_found', options.notFound);
  if (response.status === 400) {
    const text = new TextDecoder().decode(bytes);
    throw new UpstreamError(400, 'tunarr_rejected', upstreamMessage(text) || 'Tunarr rejected the request.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError(502, 'tunarr_auth', `Tunarr at ${target.host} refused the request (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new UpstreamError(502, 'tunarr_error', `Tunarr at ${target.host} returned HTTP ${response.status}.`);
  }
  return { response, bytes };
}

export async function callTunarr(
  config: ProxyConfig,
  target: TunarrTarget,
  method: UpstreamMethod,
  path: string,
  body?: string,
  notFound = 'Tunarr could not find that channel.',
): Promise<unknown> {
  const { bytes } = await fetchUpstream(config, target, method, path, { accept: 'application/json', body, notFound });
  if (!bytes.byteLength) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new UpstreamError(502, 'tunarr_invalid_response', `Tunarr at ${target.host} returned a response that is not JSON. Check TUNARR_URL.`);
  }
}

