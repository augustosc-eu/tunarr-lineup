// A channel's programming as the desk reads it (GET /api/tunarr/channels/:id/programming).
//
// Tunarr answers with the whole lineup plus full metadata for every program
// (identifiers, artwork paths, summaries): several megabytes for a large
// channel, most of which the desk never shows. The companion sends the lineup
// and schedule untouched (saves pass items through, and the version is a hash
// of exactly those), and only the program fields the desk titles rows with.
//
// Reads are shared: requests for the same channel while one is in flight wait
// for it. By default every other request reads Tunarr again, so a change made
// in Tunarr's own UI (or a schedule it regenerated) is never shown as current
// when it isn't; the browser still skips the download when nothing changed
// (ETag, 304). LINEUP_PROGRAMMING_CACHE_MS reuses a result for that long, for
// a Tunarr that is slow to answer, at the cost of such outside changes taking
// that long to appear. Any Lineup write to the channel (it runs under
// withChannelLock) drops it, including a read that was in flight when the
// write started, so a save is never followed by the lineup from before it.
// Saves are conditional either way (412), so a stale read can't overwrite anything.
import { createHash } from 'node:crypto';
import { channelBusy, channelGeneration } from './channelLock.js';
import { MAX_LINEUP_ITEMS, slimPrograms } from './lineupItems.js';

export const DEFAULT_PROGRAMMING_CACHE_MS = 0;
const MAX_ENTRIES = 16;

export type ProgrammingView = { body: string; etag: string };
export type ProgrammingSource = 'tunarr' | 'shared' | 'cache';

type Json = Record<string, unknown>;

/** Tunarr's programming with programs reduced to their titles and numbers; the lineup and schedule are untouched. */
export function slimProgramming(data: unknown): Json {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const { programs, ...rest } = data as Json;
  // One number per item, derived from the lineup and unused by the desk.
  delete rest.startTimeOffsets;
  return { ...rest, programs: slimPrograms(rest.lineup, programs, MAX_LINEUP_ITEMS) };
}

/** A weak validator for the exact body sent, so the browser can revalidate instead of downloading it again. */
export const bodyEtag = (body: string) => `W/"${createHash('sha1').update(body).digest('base64url')}"`;

/** If-None-Match against an ETag, ignoring weakness (RFC 9110 weak comparison). */
export function etagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}

export function toView(data: unknown): ProgrammingView {
  const body = JSON.stringify(slimProgramming(data));
  return { body, etag: bodyEtag(body) };
}

export type ProgrammingCache = {
  get(channelId: string, load: () => Promise<unknown>): Promise<{ view: ProgrammingView; source: ProgrammingSource }>;
  clear(): void;
};

export function createProgrammingCache(ttlMs = DEFAULT_PROGRAMMING_CACHE_MS, now: () => number = Date.now): ProgrammingCache {
  const ttl = Math.max(0, ttlMs);
  const entries = new Map<string, { generation: number; at: number; view: ProgrammingView }>();
  const inFlight = new Map<string, { generation: number; promise: Promise<ProgrammingView> }>();
  const sweep = () => {
    for (const [id, entry] of entries) if (now() - entry.at >= ttl || entry.generation !== channelGeneration(id)) entries.delete(id);
  };
  return {
    async get(channelId, load) {
      sweep();
      const generation = channelGeneration(channelId);
      const cached = entries.get(channelId);
      if (cached && !channelBusy(channelId)) return { view: cached.view, source: 'cache' };
      const pending = inFlight.get(channelId);
      if (pending && pending.generation === generation) return { view: await pending.promise, source: 'shared' };
      const promise = load().then(toView);
      inFlight.set(channelId, { generation, promise });
      try {
        const view = await promise;
        // Kept only if no write started or finished while it was being read.
        if (ttl > 0 && channelGeneration(channelId) === generation && !channelBusy(channelId)) {
          entries.delete(channelId);
          entries.set(channelId, { generation, at: now(), view });
          while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
        }
        return { view, source: 'tunarr' };
      } finally {
        if (inFlight.get(channelId)?.promise === promise) inFlight.delete(channelId);
      }
    },
    clear() {
      entries.clear();
    },
  };
}
