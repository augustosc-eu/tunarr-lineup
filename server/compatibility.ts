// What this Tunarr can do for Lineup (owner request 2026-10-25, D63). Tunarr
// changes quickly, and an update can quietly remove or reshape an endpoint the
// desk relies on. Instead of comparing version strings, the companion asks
// Tunarr read-only questions: its version (/api/version), its own API
// description (/openapi.json, which lists every route, including the ones that
// write, so saving can be checked without writing), and one small GET per
// capability, whose reply must have the shape the desk reads. Every capability
// is decided here, in one matrix, and the desk only asks "is X usable, and if
// not, why" (or, for one part of a manager, "can I create, edit or delete
// here"). Nothing here writes to Tunarr, and nothing names Tunarr's address:
// reasons are Lineup's own words, never upstream messages.
import type { ProxyConfig, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, UpstreamError } from './upstream.js';

export type CapabilityId =
  | 'connection' | 'programming' | 'guide' | 'sessions' | 'manual-saves' | 'slot-schedules'
  | 'filler-lists' | 'custom-shows' | 'smart-collections' | 'media-sources' | 'library-search'
  | 'transcode-profiles' | 'channel-settings' | 'channel-admin' | 'hls-streaming';

/** One part of a capability the desk can refuse on its own (a manager's create, edit or delete button). */
export type PartId =
  | 'create' | 'edit' | 'delete' | 'contents' | 'copy' | 'preview' | 'lookup' | 'browse'
  | 'refresh' | 'enable' | 'scan' | 'sign-in-jellyfin' | 'sign-in-emby';

/**
 * available: checked and usable, every part of it. degraded: usable, but not
 * all of it is: it answers, but not as expected (the desk may misread it), a
 * part's routes are missing (that part is refused, the rest works), the parts
 * that write couldn't be checked, or the check failed for a reason that may
 * pass (a timeout, an error). unavailable: this Tunarr definitely doesn't offer
 * it (a route it needs answers "no such route", or Tunarr's own API description
 * doesn't list a required operation); the desk refuses it with the reason.
 * untested: can't be checked without side effects; it's tried when used.
 * unknown: Tunarr couldn't be reached at all.
 */
export type CapabilityStatus = 'available' | 'degraded' | 'unavailable' | 'untested' | 'unknown';

/**
 * A part's own state, from Tunarr's API description only (writes are never
 * tried): available (listed), unavailable (the description was read and doesn't
 * list one of its routes: the desk refuses that part), unchecked (no
 * description to go by: it's tried when used).
 */
export type PartStatus = 'available' | 'unavailable' | 'unchecked';
export type CapabilityPart = { id: PartId; label: string; status: PartStatus };

export type Capability = { id: CapabilityId; label: string; status: CapabilityStatus; reason: string; uses: string; parts?: CapabilityPart[] };

export type VersionCheck = {
  /** Tunarr's version as it reports it, or null when it doesn't say. */
  tunarr: string | null;
  source: 'api' | 'openapi' | 'none';
  /** validated: inside the versions Lineup was built against; unvalidated: outside them; unknown: no version. */
  status: 'validated' | 'unvalidated' | 'unknown';
  note: string;
};

export type CompatibilityReport = {
  checkedAt: number;
  /** False when Tunarr's address isn't set up. */
  configured: boolean;
  connected: boolean;
  /** Why it isn't connected, in Lineup's words. */
  connectionError?: string;
  version: VersionCheck;
  /** Whether Tunarr's API description could be read (it makes write checks possible). */
  apiDescription: 'read' | 'missing' | 'failed' | 'not-checked';
  capabilities: Capability[];
};

/** Versions whose API shape Lineup was written and tested against. */
export const VALIDATED_VERSIONS = { from: [1, 0, 0], below: [2, 0, 0], label: '1.x' } as const;
export const COMPATIBILITY_TTL_MS = 5 * 60_000;
const PROBE_CONCURRENCY = 4;

type Op = readonly [method: 'get' | 'post' | 'put' | 'delete', path: string];
type ProbeKey = 'channels' | 'channel' | 'programming' | 'guide' | 'sessions' | 'fillerLists' | 'customShows' | 'smartCollections' | 'mediaSources' | 'search' | 'transcodeConfigs';

type Spec = {
  id: CapabilityId;
  label: string;
  /** What in the desk depends on it. */
  uses: string;
  /**
   * Required routes, as Tunarr's API description names them (parameters as {}).
   * One the description doesn't list makes the capability unavailable, unless
   * the probe read it. The first is the one the probe reads, when there is one.
   */
  ops: Op[];
  /**
   * Parts of it with routes of their own (a manager's writes): one whose route
   * the description doesn't list is refused on its own and makes the
   * capability degraded, never unavailable, so reading stays on. A capability
   * with no required routes is unavailable only when every part is.
   * `label` finishes "… won't work" ("deleting filler lists").
   */
  parts?: Array<{ id: PartId; label: string; ops: Op[] }>;
  /** The read-only request that proves it, when there is one. */
  probe?: ProbeKey;
};

/** The compatibility matrix: one row per capability, the only place the desk's dependencies on Tunarr are listed (server/content.ts and server/admin.ts make these calls). */
export const CAPABILITY_MATRIX: readonly Spec[] = [
  { id: 'connection', label: 'Connection', uses: 'Everything', ops: [['get', '/api/channels']], probe: 'channels' },
  { id: 'programming', label: 'Programming', uses: 'The desk’s lineup, snapshots, the lineup check, Control Room checks', ops: [['get', '/api/channels/{}/programming']], probe: 'programming' },
  { id: 'manual-saves', label: 'Saving lineups', uses: 'Save, Reset Channel, scheduled changes, batch repairs and imports', ops: [['post', '/api/channels/{}/programming']] },
  { id: 'slot-schedules', label: 'Slot schedules', uses: 'Edit and preview slot schedules, programming templates', ops: [['post', '/api/channels/{}/schedule-slots'], ['post', '/api/channels/{}/schedule-time-slots']] },
  { id: 'guide', label: 'Guide', uses: 'Guide grid, now and next, the desk’s guide times, Control Room', ops: [['get', '/api/guide/channels']], probe: 'guide' },
  { id: 'sessions', label: 'Viewer counts', uses: 'Viewer badges, Control Room viewers', ops: [['get', '/api/sessions']], probe: 'sessions' },
  { id: 'channel-settings', label: 'Channel settings', uses: 'Channel Settings, batch group, transcode, filler and number changes', ops: [['get', '/api/channels/{}'], ['put', '/api/channels/{}']], probe: 'channel' },
  {
    id: 'channel-admin', label: 'Creating and deleting channels', uses: 'New Channel, Duplicate Channel, Delete Channel', ops: [],
    parts: [
      // An empty channel gets the default transcode profile when none is picked (the dialog lists them too).
      { id: 'create', label: 'creating empty channels', ops: [['get', '/api/transcode_configs'], ['post', '/api/channels']] },
      // Tunarr names a copy itself; Lineup then reads it and saves the chosen name and number. Without both, a copy would be left half made.
      { id: 'copy', label: 'duplicating channels', ops: [['post', '/api/channels'], ['get', '/api/channels/{}'], ['put', '/api/channels/{}']] },
      { id: 'delete', label: 'deleting channels', ops: [['delete', '/api/channels/{}']] },
    ],
  },
  {
    id: 'filler-lists', label: 'Filler lists', uses: 'Commercials, station IDs, breaks, filler folders', ops: [['get', '/api/filler-lists']], probe: 'fillerLists',
    parts: [
      { id: 'contents', label: 'opening a list’s programs', ops: [['get', '/api/filler-lists/{}/programs']] },
      { id: 'create', label: 'creating filler lists (also from a library folder)', ops: [['post', '/api/filler-lists']] },
      { id: 'edit', label: 'changing a list’s name or programs', ops: [['put', '/api/filler-lists/{}']] },
      { id: 'delete', label: 'deleting filler lists', ops: [['delete', '/api/filler-lists/{}']] },
    ],
  },
  {
    id: 'custom-shows', label: 'Custom shows', uses: 'Custom shows, custom-show slots', ops: [['get', '/api/custom-shows']], probe: 'customShows',
    parts: [
      { id: 'contents', label: 'opening a show’s programs', ops: [['get', '/api/custom-shows/{}/programs']] },
      { id: 'create', label: 'creating custom shows', ops: [['post', '/api/custom-shows']] },
      // An edit reads the show first, to keep its playlist sync.
      { id: 'edit', label: 'editing custom shows', ops: [['get', '/api/custom-shows/{}'], ['put', '/api/custom-shows/{}']] },
      { id: 'delete', label: 'deleting custom shows', ops: [['delete', '/api/custom-shows/{}']] },
    ],
  },
  {
    id: 'smart-collections', label: 'Smart collections', uses: 'Smart collections, template roles', ops: [['get', '/api/smart_collections']], probe: 'smartCollections',
    parts: [
      { id: 'create', label: 'creating smart collections', ops: [['post', '/api/smart_collections']] },
      { id: 'edit', label: 'opening and editing smart collections', ops: [['get', '/api/smart_collections/{}'], ['put', '/api/smart_collections/{}']] },
      { id: 'delete', label: 'deleting smart collections', ops: [['delete', '/api/smart_collections/{}']] },
      { id: 'preview', label: 'previewing what a collection matches', ops: [['post', '/api/programs/search']] },
    ],
  },
  {
    id: 'media-sources', label: 'Media sources', uses: 'Library browser, program bin, Media Sources, filler folders', ops: [['get', '/api/media-sources']], probe: 'mediaSources',
    parts: [
      { id: 'create', label: 'adding media sources (also filler folders)', ops: [['post', '/api/media-sources']] },
      // Signing in only gets a token; the source is then added like any other.
      { id: 'sign-in-jellyfin', label: 'adding a Jellyfin server by signing in', ops: [['post', '/api/jellyfin/login'], ['post', '/api/media-sources']] },
      { id: 'sign-in-emby', label: 'adding an Emby server by signing in', ops: [['post', '/api/emby/login'], ['post', '/api/media-sources']] },
      { id: 'delete', label: 'removing media sources', ops: [['delete', '/api/media-sources/{}']] },
      { id: 'refresh', label: 'refreshing a source’s libraries', ops: [['post', '/api/media-sources/{}/libraries/refresh']] },
      { id: 'enable', label: 'turning libraries on and off', ops: [['put', '/api/media-sources/{}/libraries/{}']] },
      { id: 'scan', label: 'scanning libraries', ops: [['post', '/api/media-sources/{}/libraries/{}/scan']] },
    ],
  },
  {
    id: 'library-search', label: 'Library search', uses: 'Library browser, program bin, media repair replacements', ops: [['post', '/api/programs/search']], probe: 'search',
    parts: [
      { id: 'lookup', label: 'media repair replacements (each one is looked up in Tunarr first)', ops: [['get', '/api/programs/{}']] },
      { id: 'browse', label: 'opening shows and seasons in the library', ops: [['get', '/api/programs/{}/descendants']] },
    ],
  },
  {
    id: 'transcode-profiles', label: 'Transcode profiles', uses: 'Transcode Profiles, new channels, batch transcode changes', ops: [['get', '/api/transcode_configs']], probe: 'transcodeConfigs',
    parts: [
      // Edits and deletes read the profile first (to merge onto it, and to refuse deleting the default).
      { id: 'edit', label: 'editing transcode profiles', ops: [['get', '/api/transcode_configs/{}'], ['put', '/api/transcode_configs/{}']] },
      { id: 'copy', label: 'copying transcode profiles', ops: [['post', '/api/transcode_configs/{}/copy']] },
      { id: 'delete', label: 'deleting transcode profiles', ops: [['get', '/api/transcode_configs/{}'], ['delete', '/api/transcode_configs/{}']] },
    ],
  },
  { id: 'hls-streaming', label: 'Live streams (HLS)', uses: 'Watch Live, Control Room stream checks', ops: [] },
];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const opLabel = ([method, path]: Op) => `${method.toUpperCase()} ${path.replace(/\{\}/g, ':id')}`;

// ------------------------------------------------------------------ version

const SEMVER = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][0-9A-Za-z.-]{1,40})?$/;

/** A version string safe to show (letters, digits and a few signs), or null. */
export function cleanVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value && value.length <= 60 && /^[0-9A-Za-z.+_-]+$/.test(value) ? value : null;
}

const compare = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function checkVersion(version: string | null, source: VersionCheck['source']): VersionCheck {
  if (!version) return { tunarr: null, source: 'none', status: 'unknown', note: 'Tunarr didn’t say which version it is. Features are still checked one by one below.' };
  const match = SEMVER.exec(version);
  if (!match) return { tunarr: version, source, status: 'unknown', note: `“${version}” isn’t a version number Lineup can compare (a development build?). Features are checked one by one below.` };
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const inside = compare(parts, VALIDATED_VERSIONS.from) >= 0 && compare(parts, VALIDATED_VERSIONS.below) < 0;
  return inside
    ? { tunarr: version, source, status: 'validated', note: `Lineup is built for Tunarr ${VALIDATED_VERSIONS.label}.` }
    : { tunarr: version, source, status: 'unvalidated', note: `Lineup is built for Tunarr ${VALIDATED_VERSIONS.label}; this version hasn’t been validated. Features that answer as expected stay on.` };
}

// ---------------------------------------------------------- API description

/** The operations Tunarr's OpenAPI document lists, as `get /api/channels/{}/programming`. */
export function describedOperations(document: unknown): Set<string> | null {
  if (!isObject(document) || !isObject(document.paths)) return null;
  const ops = new Set<string>();
  for (const [route, item] of Object.entries(document.paths)) {
    if (!isObject(item)) continue;
    const path = route.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
    for (const method of Object.keys(item)) ops.add(`${method.toLowerCase()} ${path}`);
  }
  return ops;
}

// ------------------------------------------------------------------- probes

/** What one read-only request showed. */
export type ProbeResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'missing' | 'shape' | 'failed' | 'skipped'; reason: string };

/** A reply shape is right when the desk can read what it needs from it. */
const SHAPES: Record<ProbeKey, (data: unknown) => string | null> = {
  channels: (data) => (Array.isArray(data) ? (data.every((item) => isObject(item) && typeof item.id === 'string' && typeof item.number === 'number') ? null : 'some channels have no id or number') : 'the channel list isn’t a list'),
  channel: (data) => (isObject(data) && typeof data.id === 'string' && typeof data.number === 'number' && typeof data.name === 'string' ? null : 'the channel has no id, number or name'),
  programming: (data) => (isObject(data) && Array.isArray(data.lineup) ? (isObject(data.programs) ? null : 'the reply has no program details') : 'the reply has no lineup'),
  guide: (data) => (isObject(data) || Array.isArray(data) ? null : 'the guide isn’t a channel map'),
  sessions: (data) => (isObject(data) ? null : 'sessions aren’t grouped by channel'),
  fillerLists: (data) => (Array.isArray(data) ? null : 'the reply isn’t a list'),
  customShows: (data) => (Array.isArray(data) ? null : 'the reply isn’t a list'),
  smartCollections: (data) => (Array.isArray(data) ? null : 'the reply isn’t a list'),
  mediaSources: (data) => (Array.isArray(data) ? null : 'the reply isn’t a list'),
  search: (data) => (isObject(data) && Array.isArray(data.results) ? null : 'search results have no list'),
  transcodeConfigs: (data) => (Array.isArray(data) ? null : 'the reply isn’t a list'),
};

/** Lineup's words for a failed request; upstream messages name Tunarr's host, so they're never passed on. */
export function failureReason(error: unknown): { kind: 'missing' | 'failed' | 'shape'; reason: string } {
  if (!(error instanceof UpstreamError)) return { kind: 'failed', reason: 'The check failed unexpectedly.' };
  switch (error.code) {
    case 'tunarr_unsupported': return { kind: 'missing', reason: 'This Tunarr doesn’t have the route Lineup uses for it.' };
    case 'tunarr_timeout': return { kind: 'failed', reason: 'Tunarr didn’t answer in time.' };
    case 'tunarr_unreachable': return { kind: 'failed', reason: 'Lineup couldn’t reach Tunarr.' };
    case 'tunarr_auth': return { kind: 'failed', reason: 'Tunarr refused the request (check the user name and password in its address).' };
    case 'tunarr_redirect': return { kind: 'failed', reason: 'Tunarr answered with a redirect (check its address).' };
    case 'tunarr_invalid_response': return { kind: 'shape', reason: 'Tunarr answered with something that isn’t JSON.' };
    case 'not_found': return { kind: 'failed', reason: 'Tunarr couldn’t find what was asked for.' };
    case 'tunarr_rejected': return { kind: 'failed', reason: 'Tunarr rejected the check’s request.' };
    default: return { kind: 'failed', reason: `Tunarr returned an error (${error.status}).` };
  }
}

type Get = (path: string, body?: unknown) => Promise<unknown>;

async function probe(get: Get, key: ProbeKey, path: string, body?: unknown): Promise<ProbeResult> {
  try {
    const data = await get(path, body);
    const problem = SHAPES[key](data);
    return problem ? { ok: false, kind: 'shape', reason: `Tunarr answered, but ${problem}.` } : { ok: true, data };
  } catch (error) {
    return { ok: false, ...failureReason(error) };
  }
}

/** Runs `tasks` a few at a time, so a check doesn't open a dozen connections to Tunarr at once. */
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

// ---------------------------------------------------------------- decisions

type Evidence = {
  ops: Set<string> | null;
  /** How reading Tunarr's API description went: read, missing (an older Tunarr without one), or failed (it may pass). */
  description?: CompatibilityReport['apiDescription'];
  probes: Partial<Record<ProbeKey, ProbeResult>>;
  /** Live streams Tunarr reports right now (proves HLS works without starting one). */
  liveStreams: number;
};

const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] ?? '');

/** Each part's state: only Tunarr's API description, read successfully, can say a write route is missing. */
export function decideParts(spec: Spec, ops: Set<string> | null): CapabilityPart[] {
  return (spec.parts ?? []).map(({ id, label, ops: needs }) => ({ id, label, status: !ops ? 'unchecked' : needs.every((op) => ops.has(`${op[0]} ${op[1]}`)) ? 'available' : 'unavailable' }));
}

/**
 * Decides one capability from what the checks showed. Pure, so every
 * combination is tested. Only definite evidence makes a capability (or a part
 * of it) unavailable: Tunarr's own API description, read successfully, not
 * listing a required operation (that the probe didn't just read), or a route
 * answering "no such route". A failure that may pass (a timeout, an error, the
 * description not loading) leaves it usable, as degraded or untested. A read
 * that worked never vouches for the writes: they're decided from the
 * description alone, part by part.
 */
export function decide(spec: Spec, evidence: Evidence): Pick<Capability, 'status' | 'reason' | 'parts'> {
  const listed = (op: Op) => !evidence.ops || evidence.ops.has(`${op[0]} ${op[1]}`);
  const probeResult = spec.probe ? evidence.probes[spec.probe] : undefined;
  // A route that just answered exists, whatever the description says.
  const absent = spec.ops.filter((op, index) => !listed(op) && !(index === 0 && probeResult?.ok));
  const parts = decideParts(spec, evidence.ops);
  const withParts = (decided: Pick<Capability, 'status' | 'reason'>): Pick<Capability, 'status' | 'reason' | 'parts'> => (parts.length ? { ...decided, parts } : decided);
  const missing = (spec.parts ?? []).filter(({ id }) => parts.find((part) => part.id === id)?.status === 'unavailable');
  const unchecked = parts.filter((part) => part.status === 'unchecked');
  const partNote = missing.length
    ? ` Tunarr’s API doesn’t list ${list([...new Set(missing.flatMap(({ ops }) => ops.filter((op) => !listed(op)).map(opLabel)))])}, so ${list(missing.map(({ label }) => label))} won’t work; the rest does.`
    : unchecked.length ? ` ${unchecked.length === parts.length ? 'Its changes' : list(unchecked.map(({ label }) => label))} couldn’t be checked (${evidence.description === 'failed' ? 'Tunarr’s API description didn’t load just now' : 'Tunarr doesn’t describe its API'}), so ${unchecked.length === 1 ? 'it’s' : 'they’re'} tried when used.` : '';
  // A read that worked, with parts missing or unchecked, is usable but not whole.
  const readWorks = (status: CapabilityStatus, reason: string): Pick<Capability, 'status' | 'reason' | 'parts'> => withParts(partNote && status === 'available' ? { status: 'degraded', reason: `${reason}${partNote}` } : { status, reason: `${reason}${partNote}` });

  if (spec.id === 'hls-streaming') {
    return evidence.liveStreams > 0
      ? { status: 'available', reason: `${evidence.liveStreams} live ${evidence.liveStreams === 1 ? 'stream' : 'streams'} in Tunarr right now.` }
      : { status: 'untested', reason: 'Checking would start a stream in Tunarr, so it’s checked when you watch (or with a Control Room stream check).' };
  }
  if (absent.length) {
    const reads = probeResult?.ok ? 'Reading works, but ' : '';
    return withParts({ status: 'unavailable', reason: `${reads}${reads ? 't' : 'T'}his Tunarr’s API doesn’t list ${absent.map(opLabel).join(', ')}, which ${spec.label.toLowerCase()} needs, so it’s turned off instead of failing when used.` });
  }
  // Nothing required of its own (only parts): off when every part is.
  if (!spec.ops.length && parts.length && missing.length === parts.length) {
    return withParts({ status: 'unavailable', reason: `This Tunarr’s API doesn’t list ${list([...new Set(missing.flatMap(({ ops }) => ops.filter((op) => !listed(op)).map(opLabel)))])}, so ${list(missing.map(({ label }) => label))} ${missing.length === 1 ? 'is' : 'are'} turned off instead of failing when used.` });
  }
  if (probeResult) {
    if (probeResult.ok) return readWorks('available', 'Checked with a read-only request.');
    if (probeResult.kind === 'missing') return withParts({ status: 'unavailable', reason: probeResult.reason });
    if (probeResult.kind === 'shape') return readWorks('degraded', `${probeResult.reason} The desk may show it wrongly.`);
    if (probeResult.kind === 'skipped') return readWorks('untested', probeResult.reason);
    // Timeouts and errors may pass: still usable, never turned off on this alone.
    return readWorks('degraded', `It couldn’t be checked just now (${probeResult.reason.replace(/\.$/, '')}); it stays on and is tried when used.`);
  }
  // Nothing to read: only the API description can say (saving is never tried, since it would write).
  if (!evidence.ops) {
    return withParts(evidence.description === 'failed'
      ? { status: 'degraded', reason: 'Tunarr’s API description couldn’t be read just now, so this wasn’t checked. It stays on and is tried when you use it.' }
      : { status: 'untested', reason: 'Tunarr doesn’t describe its API, so this can’t be checked without writing. It’s tried when you use it.' });
  }
  return readWorks('available', 'Listed in Tunarr’s API (not tried, since trying would write).');
}

// --------------------------------------------------------------------- run

const smallestChannel = (channels: unknown) => {
  const list = (Array.isArray(channels) ? channels : []).filter((item): item is Json => isObject(item) && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id));
  return list.sort((a, b) => (Number(a.programCount) || 0) - (Number(b.programCount) || 0))[0];
};

const SKIP = (reason: string): ProbeResult => ({ ok: false, kind: 'skipped', reason });

/**
 * Asks `target` what it can do. Read-only: GETs, Tunarr's API description, and
 * one library search for a single result. Used for the running server (cached
 * below) and for an address being tested in setup (not cached).
 */
export async function detectCompatibility(config: ProxyConfig, target: TunarrTarget, now = Date.now()): Promise<CompatibilityReport> {
  const get: Get = (path, body) => callTunarr(config, target, body === undefined ? 'GET' : 'POST', path, body === undefined ? undefined : JSON.stringify(body));
  const capabilities = (status: CapabilityStatus, reason: string) => CAPABILITY_MATRIX.map(({ id, label, uses }) => ({ id, label, uses, status, reason }));

  const channels = await probe(get, 'channels', '/api/channels');
  if (!channels.ok && channels.kind !== 'shape') {
    const report: CompatibilityReport = {
      checkedAt: now, configured: true, connected: false, connectionError: channels.reason,
      version: checkVersion(null, 'none'), apiDescription: 'not-checked',
      capabilities: capabilities('unknown', 'Not checked: Lineup couldn’t reach Tunarr.'),
    };
    report.capabilities[0] = { ...report.capabilities[0], status: channels.kind === 'missing' ? 'unavailable' : 'unknown', reason: channels.reason };
    return report;
  }

  const sample = channels.ok ? smallestChannel(channels.data) : undefined;
  const from = new Date(now);
  const to = new Date(now + 5 * 60_000);
  const [versionReply, description, ...rest] = await bounded<unknown>([
    () => get('/api/version').catch((error: unknown) => ({ failed: error })),
    () => get('/openapi.json').catch((error: unknown) => ({ failed: error })),
    () => (sample ? probe(get, 'channel', `/api/channels/${sample.id}`) : Promise.resolve(SKIP('There’s no channel to read yet.'))),
    () => (sample ? probe(get, 'programming', `/api/channels/${sample.id}/programming`) : Promise.resolve(SKIP('There’s no channel to read yet.'))),
    () => probe(get, 'guide', `/api/guide/channels?${new URLSearchParams({ dateFrom: from.toISOString(), dateTo: to.toISOString() })}`),
    () => probe(get, 'sessions', '/api/sessions'),
    () => probe(get, 'fillerLists', '/api/filler-lists'),
    () => probe(get, 'customShows', '/api/custom-shows'),
    () => probe(get, 'smartCollections', '/api/smart_collections'),
    () => probe(get, 'mediaSources', '/api/media-sources'),
    () => probe(get, 'transcodeConfigs', '/api/transcode_configs'),
  ], PROBE_CONCURRENCY) as [unknown, unknown, ...ProbeResult[]];
  const [channel, programming, guide, sessions, fillerLists, customShows, smartCollections, mediaSources, transcodeConfigs] = rest;

  // One search for one result, in the first enabled library: read-only, and proves the search body Lineup builds.
  let search: ProbeResult = SKIP('There’s no enabled media library to search yet.');
  if (mediaSources.ok) {
    const source = (mediaSources.data as unknown[]).filter(isObject).find((item) => typeof item.id === 'string' && Array.isArray(item.libraries) && item.libraries.some((library) => isObject(library) && library.enabled !== false && typeof library.id === 'string'));
    const library = source && (source.libraries as unknown[]).filter(isObject).find((item) => item.enabled !== false && typeof item.id === 'string');
    if (source && library) search = await probe(get, 'search', '/api/programs/search', { mediaSourceId: source.id, libraryId: library.id, query: {}, page: 0, limit: 1 });
  }

  const describeError = isObject(description) && 'failed' in description ? description.failed : undefined;
  const ops = describeError === undefined ? describedOperations(description) : null;
  // An older Tunarr without the document answers 404; anything else is a failed read.
  const apiDescription: CompatibilityReport['apiDescription'] = ops ? 'read'
    : describeError instanceof UpstreamError && (describeError.status === 404 || describeError.status === 501) ? 'missing' : 'failed';

  const versionFailed = isObject(versionReply) && 'failed' in versionReply;
  const apiVersion = !versionFailed && isObject(versionReply) ? cleanVersion(versionReply.tunarr) : null;
  const describedVersion = ops && isObject(description) && isObject(description.info) ? cleanVersion(description.info.version) : null;
  const version = apiVersion ? checkVersion(apiVersion, 'api') : describedVersion ? checkVersion(describedVersion, 'openapi') : checkVersion(null, 'none');

  const liveStreams = sessions.ok && isObject(sessions.data)
    ? Object.values(sessions.data).reduce((sum: number, list) => sum + (Array.isArray(list) ? list.filter((session) => isObject(session) && session.state !== 'stopped' && session.state !== 'error').length : 0), 0)
    : 0;
  const evidence: Evidence = { ops, description: apiDescription, liveStreams, probes: { channels, channel, programming, guide, sessions, fillerLists, customShows, smartCollections, mediaSources, search, transcodeConfigs } };
  return {
    checkedAt: now, configured: true, connected: true, version, apiDescription,
    capabilities: CAPABILITY_MATRIX.map((spec) => ({ id: spec.id, label: spec.label, uses: spec.uses, ...decide(spec, evidence) })),
  };
}

export function notConfiguredReport(now = Date.now(), why = 'Tunarr’s address isn’t set up on the Lineup server.'): CompatibilityReport {
  return {
    checkedAt: now, configured: false, connected: false, connectionError: why, version: checkVersion(null, 'none'), apiDescription: 'not-checked',
    capabilities: CAPABILITY_MATRIX.map(({ id, label, uses }) => ({ id, label, uses, status: 'unknown', reason: 'Not checked: Tunarr isn’t set up.' })),
  };
}

// ------------------------------------------------------------------- cache

type Cached = { where: string; report?: CompatibilityReport; running?: Promise<CompatibilityReport> };
const cache = new WeakMap<ProxyConfig, Cached>();

/**
 * The running server's report, kept COMPATIBILITY_TTL_MS. A refresh always
 * checks again; checks for the same Tunarr share one run. A failed check is
 * kept like any other result (it says what failed), never hidden.
 */
export function compatibility(config: ProxyConfig, { refresh = false, now = Date.now() }: { refresh?: boolean; now?: number } = {}): Promise<CompatibilityReport> {
  const target = config.target;
  if (!target) return Promise.resolve(notConfiguredReport(now, config.configError ? 'Tunarr’s saved address isn’t valid.' : undefined));
  const where = `${target.origin}${target.basePath}`;
  let entry = cache.get(config);
  if (!entry || entry.where !== where) {
    entry = { where };
    cache.set(config, entry);
  }
  if (entry.running) return entry.running;
  if (!refresh && entry.report && now - entry.report.checkedAt < COMPATIBILITY_TTL_MS) return Promise.resolve(entry.report);
  const current = entry;
  current.running = detectCompatibility(config, target, now)
    .then((report) => { if (cache.get(config) === current) current.report = report; return report; })
    .finally(() => { current.running = undefined; });
  return current.running;
}

/** The report from the last check, if one is still fresh (no Tunarr request). */
export function cachedCompatibility(config: ProxyConfig, now = Date.now()): CompatibilityReport | undefined {
  const entry = cache.get(config);
  const target = config.target;
  if (!entry?.report || !target || entry.where !== `${target.origin}${target.basePath}`) return undefined;
  return now - entry.report.checkedAt < COMPATIBILITY_TTL_MS ? entry.report : undefined;
}

/** Why `id` (or its `part`) can't be used on this Tunarr, or null when it can (or hasn't been ruled out). */
export function unavailableReason(report: CompatibilityReport | undefined, id: CapabilityId, part?: PartId): string | null {
  const capability = report?.capabilities.find((item) => item.id === id);
  if (capability?.status === 'unavailable') return `${capability.label} isn’t available on this Tunarr: ${capability.reason}`;
  const missing = part ? capability?.parts?.find((item) => item.id === part && item.status === 'unavailable') : undefined;
  return missing ? `This Tunarr’s API doesn’t offer ${missing.label}.` : null;
}

/** A short line for Test Connection: the version and how many features are missing. */
export function compatibilitySummary(report: CompatibilityReport) {
  const count = (status: CapabilityStatus) => report.capabilities.filter((item) => item.status === status).length;
  return { version: report.version.tunarr, versionStatus: report.version.status, unavailable: count('unavailable'), degraded: count('degraded') };
}
