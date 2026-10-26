// The Control Room's rules on the desk's side (server/controlRoom.ts): one
// status per channel from what's known about it, the filters, and paging.
// Pure; the component only renders and moves the focus.
import type { ChannelSummary, ControlRoomSummary } from '../server/controlRoom';
import type { HealthStatus } from '../server/channelHealth';

export type { ChannelSummary, ControlRoomSummary, HealthStatus };

export type StreamCheck = { ok: boolean; message: string; at: number };
export type RoomFilter = 'all' | 'errors' | 'warnings' | 'viewers' | 'scheduled';

export const ROOM_FILTERS: Array<{ id: RoomFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'errors', label: 'Errors' },
  { id: 'warnings', label: 'Warnings' },
  { id: 'viewers', label: 'Watched' },
  { id: 'scheduled', label: 'Scheduled' },
];

export const HEALTH_LABELS: Record<HealthStatus, string> = { healthy: 'Healthy', warning: 'Warning', error: 'Error', unknown: 'Not checked', unsupported: 'Unsupported' };

/** How often the light summary refreshes while the Control Room is open and visible. */
export const ROOM_REFRESH_MS = 60_000;
/** Rows a PageUp/PageDown moves. */
export const ROOM_PAGE = 8;
/** A stream check reads only the playlist, and gives up after this long. */
export const STREAM_CHECK_MS = 15_000;

const RANK: Record<HealthStatus, number> = { unsupported: 0, unknown: 1, healthy: 2, warning: 3, error: 4 };
const worst = (a: HealthStatus, b: HealthStatus) => (RANK[b] > RANK[a] ? b : a);

/**
 * One status for a channel: the last deep check, made worse (never better) by
 * what the light summary or a stream check shows. Without a deep check a
 * channel is "not checked", or unsupported when Tunarr can't give its
 * programming at all; nothing is ever called healthy without a check.
 */
export function channelStatus(channel: ChannelSummary, summary: Pick<ControlRoomSummary, 'programming'>, stream?: StreamCheck): HealthStatus {
  let status: HealthStatus = channel.diagnostic?.status ?? (summary.programming.status === 'unsupported' ? 'unsupported' : 'unknown');
  if (channel.guide === 'empty') status = worst(status, 'warning');
  if (stream && !stream.ok) status = worst(status, 'error');
  return status;
}

/** Problems that don't come from the deep check: guide availability and the stream check. */
export function summaryNotes(channel: ChannelSummary, stream?: StreamCheck): string[] {
  const notes: string[] = [];
  if (channel.guide === 'empty') notes.push('Tunarr’s guide has nothing for this channel in the next three hours.');
  if (stream) notes.push(stream.ok ? `Stream playlist answered (${timeLabel(stream.at)}).` : `Stream check failed: ${stream.message}`);
  return notes;
}

export function matchesFilter(filter: RoomFilter, channel: ChannelSummary, status: HealthStatus) {
  switch (filter) {
    case 'errors': return status === 'error';
    case 'warnings': return status === 'warning';
    case 'viewers': return channel.viewers > 0 || channel.streams > 0;
    case 'scheduled': return channel.pendingChanges > 0;
    default: return true;
  }
}

export function filterCounts(rows: Array<{ channel: ChannelSummary; status: HealthStatus }>): Record<RoomFilter, number> {
  return Object.fromEntries(ROOM_FILTERS.map(({ id }) => [id, rows.filter((row) => matchesFilter(id, row.channel, row.status)).length])) as Record<RoomFilter, number>;
}

export const nextFilter = (filter: RoomFilter) => ROOM_FILTERS[(ROOM_FILTERS.findIndex((item) => item.id === filter) + 1) % ROOM_FILTERS.length].id;

/** The row the focus lands on after a key: arrows step, pages jump, Home/End go to the ends. */
export function stepRow(current: number, total: number, key: string): number {
  if (!total) return 0;
  const clamp = (value: number) => Math.max(0, Math.min(total - 1, value));
  switch (key) {
    case 'ArrowDown': return clamp(current + 1);
    case 'ArrowUp': return clamp(current - 1);
    case 'PageDown': case 'ChannelDown': return clamp(current + ROOM_PAGE);
    case 'PageUp': case 'ChannelUp': return clamp(current - ROOM_PAGE);
    case 'Home': return 0;
    case 'End': return total - 1;
    default: return clamp(current);
  }
}

/** Channel ids in batches the companion accepts (server/controlRoom.ts MAX_CHECK_CHANNELS). */
export function checkBatches(ids: string[], size = 25): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}

export const timeLabel = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
export const minutesLeft = (stop: number, now: number) => Math.max(0, Math.round((stop - now) / 60_000));

/**
 * The opt-in stream check: asks the companion for the channel's HLS playlist
 * and reads that one small text, never a video segment. It still makes Tunarr
 * start the channel for a moment, which is why it only runs when asked.
 */
export async function checkStream(url: string, signal?: AbortSignal, timeoutMs = STREAM_CHECK_MS, now = () => Date.now()): Promise<StreamCheck> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, headers: { accept: 'application/vnd.apple.mpegurl' } });
    const text = (await response.text()).slice(0, 4096);
    if (!response.ok) {
      let message = `the Lineup server answered ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // Not JSON: keep the status.
      }
      return { ok: false, message, at: now() };
    }
    return text.trimStart().startsWith('#EXTM3U') ? { ok: true, message: 'Playlist answered.', at: now() } : { ok: false, message: 'the reply wasn’t an HLS playlist.', at: now() };
  } catch {
    return { ok: false, message: signal?.aborted ? 'cancelled.' : controller.signal.aborted ? `no answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'the Lineup server couldn’t be reached.', at: now() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
