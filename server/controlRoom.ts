// The Control Room (roadmap milestone 2): every channel at a glance. The
// summary is light and safe to refresh: the channel list, a three-hour guide
// window for now and next, viewer counts and scheduled changes, each read once
// for all channels, so one failing read leaves the rest of the page intact.
// The deeper check reads each channel's programming (which can be megabytes),
// so it runs only when asked, for at most MAX_CHECK_CHANNELS channels per
// request, three at a time, and its results are kept in memory with the time
// they were taken. Nothing here writes to Tunarr or starts a stream.
import { cachedCompatibility, failureReason, unavailableReason } from './compatibility.js';
import { channelFindings, healthStatus, loopFindings, sortFindings, type ChannelDiagnostic } from './channelHealth.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json } from './upstream.js';
import { slimGuide, viewerCounts, type GuideEntry } from './watch.js';

export const MAX_CHECK_CHANNELS = 25;
export const CHECK_CONCURRENCY = 3;
const GUIDE_WINDOW_MS = 3 * 3_600_000;
const MAX_KEPT = 2_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type ControlRoomRoute = { name: 'control-room'; methods: string[] } | { name: 'control-room-check'; methods: string[] };

export function matchControlRoomRoute(path: string): ControlRoomRoute | null {
  if (path === '/control-room') return { name: 'control-room', methods: ['GET'] };
  if (path === '/control-room/check') return { name: 'control-room-check', methods: ['POST'] };
  return null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** One part of the summary: read, failed (with Lineup's reason), or turned off because Tunarr lacks it. */
export type PartStatus = { status: 'ok' } | { status: 'error' | 'unsupported'; message: string };

export type Airing = Pick<GuideEntry, 'start' | 'stop' | 'type' | 'title' | 'detail'>;

export type ChannelSummary = {
  id: string;
  number: number;
  name: string;
  group: string;
  viewers: number;
  streams: number;
  now: Airing | null;
  next: Airing | null;
  /** ok: the guide has this channel now; empty: it has nothing for it; error/unsupported: see the summary's guide part. */
  guide: 'ok' | 'empty' | 'error' | 'unsupported';
  pendingChanges: number;
  nextChangeAt: number | null;
  /** The last deep check, if one was run since the companion started. */
  diagnostic: ChannelDiagnostic | null;
};

export type ControlRoomSummary = {
  at: number;
  guide: PartStatus;
  sessions: PartStatus;
  scheduler: { enabled: boolean };
  /** Whether programming can be read at all (Server Settings → Compatibility); deep checks need it. */
  programming: PartStatus;
  channels: ChannelSummary[];
};

// Diagnostics live in memory, per server: a restart forgets them (they're a snapshot, not a record).
const diagnosticsFor = new WeakMap<ProxyConfig, Map<string, ChannelDiagnostic>>();
function diagnostics(config: ProxyConfig) {
  let map = diagnosticsFor.get(config);
  if (!map) {
    map = new Map();
    diagnosticsFor.set(config, map);
  }
  return map;
}

type ChannelRef = { id: string; number: number; name: string; group: string };
function channelRefs(list: unknown): ChannelRef[] {
  return (Array.isArray(list) ? list : []).filter(isObject).flatMap((channel) => (typeof channel.id === 'string' && CHANNEL_ID.test(channel.id) && typeof channel.number === 'number'
    ? [{ id: channel.id, number: channel.number, name: String(channel.name ?? '').slice(0, 120), group: typeof channel.groupTitle === 'string' ? channel.groupTitle.slice(0, 120) : '' }]
    : [])).sort((a, b) => a.number - b.number);
}

const airing = (entry: GuideEntry | undefined): Airing | null => (entry ? { start: entry.start, stop: entry.stop, type: entry.type, title: entry.title, detail: entry.detail } : null);
const part = (blocked: string | null, error: unknown): PartStatus => (blocked ? { status: 'unsupported', message: blocked } : error ? { status: 'error', message: failureReason(error).reason } : { status: 'ok' });

/** The light summary: one read each of channels, guide, sessions, and the scheduled changes on file. */
export async function controlRoomSummary(config: ProxyConfig, target: TunarrTarget, now = Date.now()): Promise<ControlRoomSummary> {
  const report = cachedCompatibility(config, now);
  const channels = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const guideBlocked = unavailableReason(report, 'guide');
  const sessionsBlocked = unavailableReason(report, 'sessions');
  const query = new URLSearchParams({ dateFrom: new Date(now).toISOString(), dateTo: new Date(now + GUIDE_WINDOW_MS).toISOString() });
  const [guide, sessions, scheduled] = await Promise.all([
    guideBlocked ? Promise.resolve({ error: null }) : callTunarr(config, target, 'GET', `/api/guide/channels?${query}`).then((raw) => ({ data: slimGuide(raw) }), (error: unknown) => ({ error })),
    sessionsBlocked ? Promise.resolve({ error: null }) : callTunarr(config, target, 'GET', '/api/sessions').then((raw) => ({ data: viewerCounts(raw, CHANNEL_ID) }), (error: unknown) => ({ error })),
    config.scheduler ? config.scheduler.store.list().catch(() => []) : Promise.resolve([]),
  ]);
  const guidePart = part(guideBlocked, 'error' in guide ? guide.error ?? null : null);
  if (guidePart.status === 'error') config.notifier?.notify({ event: 'guide.failed', severity: 'warning', summary: `Tunarr’s guide couldn’t be read: ${guidePart.message}`, dedupe: { key: 'guide', ms: 3_600_000 } });
  const sessionsPart = part(sessionsBlocked, 'error' in sessions ? sessions.error ?? null : null);
  const guideById = new Map(('data' in guide ? guide.data : []).map((channel) => [channel.id, channel.programs]));
  const counts = 'data' in sessions ? sessions.data : {};
  const pending = scheduled.filter((change) => change.status === 'pending');
  const kept = diagnostics(config);
  return {
    at: now,
    guide: guidePart,
    sessions: sessionsPart,
    scheduler: { enabled: !!config.scheduler?.enabled },
    programming: part(unavailableReason(report, 'programming'), null),
    channels: channels.map((channel) => {
      const programs = guideById.get(channel.id);
      const onNow = programs?.find((entry) => entry.start <= now && now < entry.stop);
      const upcoming = programs?.find((entry) => entry.start >= (onNow?.stop ?? now));
      const changes = pending.filter((change) => change.channelId === channel.id);
      return {
        ...channel,
        viewers: counts[channel.id]?.viewers ?? 0,
        streams: counts[channel.id]?.streams ?? 0,
        now: airing(onNow),
        next: airing(upcoming),
        guide: guidePart.status !== 'ok' ? guidePart.status : programs?.length ? 'ok' : 'empty',
        pendingChanges: changes.length,
        nextChangeAt: changes.length ? Math.min(...changes.map((change) => change.at)) : null,
        diagnostic: kept.get(channel.id) ?? null,
      };
    }),
  };
}

/** Tells the owner about a channel that became unhealthy, or plays programs Tunarr no longer has (once per change, not every check). */
function notifyHealth(config: ProxyConfig, result: ChannelDiagnostic, before: ChannelDiagnostic | undefined, ref: ChannelRef | undefined) {
  const channel = { id: result.channelId, ...(ref ? { number: ref.number, name: ref.name } : {}) };
  const on = ref ? `CH ${ref.number} ${ref.name}` : 'a channel';
  // Without names: the number only.
  const where = ref ? `channel ${ref.number}` : 'a channel';
  const errors = result.findings.filter((finding) => finding.severity === 'error').length;
  if (result.status === 'error' && before?.status !== 'error') {
    config.notifier?.notify({ event: 'channel.unhealthy', severity: 'error', channel, counts: { errors, warnings: result.findings.filter((finding) => finding.severity === 'warning').length }, summary: `A Control Room check found ${errors} error${errors === 1 ? '' : 's'} on ${where}.`, named: `A Control Room check found ${errors} error${errors === 1 ? '' : 's'} on ${on}: ${result.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.title).slice(0, 3).join('; ')}.`, dedupe: { key: `unhealthy:${result.channelId}`, ms: 6 * 3_600_000 } });
  }
  const missing = result.findings.find((finding) => finding.id === 'missing-program');
  const count = missing ? Number(/^\d+/.exec(missing.title)?.[0] ?? 1) : 0;
  if (count) config.notifier?.notify({ event: 'media.missing', severity: 'warning', channel, counts: { programs: count }, summary: `${count} program${count === 1 ? '' : 's'} on ${where} ${count === 1 ? 'is' : 'are'} no longer in Tunarr’s library. Use Repair Missing Media in the desk.`, named: `${count} program${count === 1 ? '' : 's'} on ${on} ${count === 1 ? 'is' : 'are'} no longer in Tunarr’s library. Use Repair Missing Media in the desk.`, dedupe: { key: `missing:${result.channelId}:${count}`, ms: 24 * 3_600_000 } });
}

export function validateCheck(body: unknown): { channelIds: string[] } | { error: string } {
  if (!isObject(body) || !Array.isArray(body.channelIds)) return { error: 'Send { "channelIds": [...] }.' };
  const ids = [...new Set(body.channelIds)];
  if (!ids.length) return { error: 'Choose at least one channel to check.' };
  if (ids.length > MAX_CHECK_CHANNELS) return { error: `Check up to ${MAX_CHECK_CHANNELS} channels at a time.` };
  if (ids.some((id) => typeof id !== 'string' || !CHANNEL_ID.test(id))) return { error: 'A channel id is not valid.' };
  return { channelIds: ids as string[] };
}

/** Runs `tasks` a few at a time. */
async function bounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

/**
 * The deep check for some channels: each one's programming and channel
 * document, plus one guide read and one filler-list read for all of them. A
 * channel that fails is reported as unknown with the reason; the others still
 * finish. Each programming reply is reduced to findings as soon as it arrives,
 * so at most CHECK_CONCURRENCY lineups are held at once.
 */
export async function checkChannels(config: ProxyConfig, target: TunarrTarget, channelIds: string[], now = Date.now()): Promise<ChannelDiagnostic[]> {
  const report = cachedCompatibility(config, now);
  const blocked = unavailableReason(report, 'programming');
  if (blocked) {
    return channelIds.map((channelId) => ({ channelId, checkedAt: now, status: 'unsupported', mode: 'unknown', items: 0, cycleMs: 0, findings: [], redirects: [], error: blocked }));
  }
  const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const names = new Map(all.map((channel) => [channel.id, `CH ${channel.number} ${channel.name}`]));
  const minute = new URLSearchParams({ dateFrom: new Date(now).toISOString(), dateTo: new Date(now + 60_000).toISOString() });
  const [fillerLists, guide] = await Promise.all([
    callTunarr(config, target, 'GET', '/api/filler-lists').then((lists) => new Set((Array.isArray(lists) ? lists : []).filter(isObject).map((list) => String(list.id))), () => null),
    unavailableReason(report, 'guide') ? Promise.resolve(null) : callTunarr(config, target, 'GET', `/api/guide/channels?${minute}`).then(slimGuide, () => null),
  ]);
  const guideNow = (channelId: string) => {
    if (!guide) return null;
    const entry = guide.find((channel) => channel.id === channelId)?.programs.find((program) => program.start <= now && now < program.stop);
    return entry ? { type: entry.type, id: entry.id, title: entry.title } : null;
  };

  const results = await bounded(channelIds.map((channelId) => async (): Promise<ChannelDiagnostic> => {
    if (!names.has(channelId)) return { channelId, checkedAt: now, status: 'unknown', mode: 'unknown', items: 0, cycleMs: 0, findings: [], redirects: [], error: 'Tunarr no longer has this channel.' };
    try {
      const [programming, channel] = await Promise.all([
        callTunarr(config, target, 'GET', `/api/channels/${channelId}/programming`),
        callTunarr(config, target, 'GET', `/api/channels/${channelId}`),
      ]);
      const found = channelFindings({ channelId, programming, channel, channelNames: names, fillerListIds: fillerLists, guideNow: guideNow(channelId), now });
      return { channelId, checkedAt: now, status: 'unknown', ...found };
    } catch (error) {
      return { channelId, checkedAt: now, status: 'unknown', mode: 'unknown', items: 0, cycleMs: 0, findings: [], redirects: [], error: failureReason(error).reason };
    }
  }), CHECK_CONCURRENCY);

  // Loops need every channel's redirects: this batch's, plus those kept from earlier checks of channels still there.
  const kept = diagnostics(config);
  const edges = new Map<string, string[]>();
  for (const [id, diagnostic] of kept) if (names.has(id) && !diagnostic.error) edges.set(id, diagnostic.redirects);
  for (const result of results) if (!result.error) edges.set(result.channelId, result.redirects);
  for (const result of results) {
    if (!result.error) result.findings = sortFindings([...result.findings, ...loopFindings(result.channelId, edges, names)]);
    result.status = healthStatus(result.findings, result.error);
    const before = kept.get(result.channelId);
    kept.delete(result.channelId);
    kept.set(result.channelId, result);
    notifyHealth(config, result, before, all.find((channel) => channel.id === result.channelId));
  }
  // Oldest first out, so a server with thousands of channels stays bounded.
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
  return results;
}

export async function handleControlRoomRoute(route: ControlRoomRoute, { config, target, body }: { config: ProxyConfig; target: TunarrTarget; body: unknown }): Promise<ProxyResponse> {
  if (route.name === 'control-room') return json(200, await controlRoomSummary(config, target));
  const checked = validateCheck(body);
  if ('error' in checked) return fail(400, 'invalid_request', checked.error);
  return json(200, { diagnostics: await checkChannels(config, target, checked.channelIds) });
}
