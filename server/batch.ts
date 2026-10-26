// Batch operations across channels (roadmap milestone 3, D65): channel
// settings (filler lists, group title, transcode profile, numbers, a few
// options), media repair, and importing a programming package. Every batch
// follows the same path:
//
//   choose channels → configure → read each channel → preview the exact diff
//   → apply channel by channel, each under its lock, only if it still matches
//   what was previewed, after a snapshot → report each channel's outcome
//   → roll back chosen channels, again only if they still match.
//
// There is no force. A channel that changed since the preview is a conflict
// and keeps its own state; the others still go in. Settings are merged onto
// Tunarr's own copy of the channel (only allowlisted fields change, as in
// Channel Settings); lineups keep their items untouched and are saved as
// manual lineups, which is never done to a channel generated from a slot
// schedule (it would detach it). Nothing here forwards a request to Tunarr.
import { createBatchStore, isBatchId, summarizeBatch, type BatchChannel, type BatchOperation, type BatchRecord, type BatchStore } from './batchStore.js';
import { withChannelLock } from './channelLock.js';
import { StoreError } from './jsonFile.js';
import { failureReason } from './compatibility.js';
import { MAX_CHANNEL_NUMBER, NOT_SAVEABLE, validateChannelSettings } from './content.js';
import { lineupLength, programmingVersion } from './lineupVersion.js';
import { buildPackage, importSummary, MAX_PACKAGE_CHANNELS, packageChannel, validatePackage, type ProgrammingPackage } from './programmingPackage.js';
import type { ProxyConfig, ProxyResponse, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json, UpstreamError } from './upstream.js';

export { createBatchStore };
export const MAX_BATCH_CHANNELS = 50;
const READ_CONCURRENCY = 3;
/** Options a batch may set; the rest of Channel Settings stays per channel. */
export const BATCH_SETTING_FIELDS = ['stealth', 'onDemand', 'guideMinimumDuration', 'guideFlexTitle', 'streamMode', 'subtitlesEnabled'] as const;
const FILLER_FIELDS = ['fillerCollections', 'fillerRepeatCooldown', 'disableFillerOverlay'] as const;
const OPERATIONS: readonly BatchOperation[] = ['filler', 'group', 'transcode', 'renumber', 'settings', 'repair', 'import'];
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REPAIR_DECISIONS = 500;
const MAX_ITEM_MS = 7 * 86_400_000;

export const FIELD_LABELS: Record<string, string> = {
  fillerCollections: 'Filler lists', fillerRepeatCooldown: 'Filler repeat cooldown', disableFillerOverlay: 'Hide watermark during filler',
  groupTitle: 'Group', transcodeConfigId: 'Transcode profile', number: 'Number', stealth: 'Hidden channel', onDemand: 'On demand',
  guideMinimumDuration: 'Minimum guide entry', guideFlexTitle: 'Guide title for flex', streamMode: 'Stream format', subtitlesEnabled: 'Subtitles',
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ------------------------------------------------------------ the request

/** A repair choice. A replacement names a program by id only; its length is always Tunarr's (`resolveReplacements`). */
export type RepairDecision = { action: 'remove' | 'flex' | 'replace' | 'ignore'; replacement?: { id: string; duration?: number } };

export type BatchParams =
  | { operation: 'filler' | 'group' | 'transcode' | 'settings'; changes: Json }
  | { operation: 'renumber'; numbers: Record<string, number> }
  | { operation: 'repair'; decisions: Record<string, RepairDecision> }
  | { operation: 'import'; package: ProgrammingPackage; mapping: Record<string, string> };

export type BatchRequest = { params: BatchParams; channelIds: string[] };

/** Validates what a batch will do. `channelIds` are the channels it changes. */
export function validateBatch(body: unknown): BatchRequest | { error: string } {
  if (!isObject(body)) return { error: 'Send { "operation", "channelIds", "params" }.' };
  const operation = body.operation as BatchOperation;
  if (!OPERATIONS.includes(operation)) return { error: 'Unknown batch operation.' };
  const params = isObject(body.params) ? body.params : {};
  let channelIds = Array.isArray(body.channelIds) ? [...new Set(body.channelIds)] : [];

  if (operation === 'import') {
    const checked = validatePackage(params.package);
    if ('error' in checked) return checked;
    if (!isObject(params.mapping) || !Object.keys(params.mapping).length) return { error: 'Choose which channel each packaged lineup goes to.' };
    const mapping: Record<string, string> = {};
    for (const [from, to] of Object.entries(params.mapping)) {
      if (!checked.package.channels.some((channel) => channel.id === from)) return { error: 'The mapping names a channel that isn’t in the package.' };
      if (typeof to !== 'string' || !CHANNEL_ID.test(to)) return { error: 'The mapping names a channel id that isn’t valid.' };
      mapping[from] = to;
    }
    channelIds = Object.values(mapping);
    if (new Set(channelIds).size !== channelIds.length) return { error: 'Two packaged lineups can’t go to the same channel.' };
    return { channelIds, params: { operation, package: checked.package, mapping } };
  }

  if (!channelIds.length) return { error: 'Choose at least one channel.' };
  if (channelIds.length > MAX_BATCH_CHANNELS) return { error: `A batch changes up to ${MAX_BATCH_CHANNELS} channels.` };
  if (channelIds.some((id) => typeof id !== 'string' || !CHANNEL_ID.test(id))) return { error: 'A channel id is not valid.' };
  const ids = channelIds as string[];

  switch (operation) {
    case 'renumber': {
      if (!isObject(params.numbers)) return { error: 'Send the new number for each channel.' };
      const numbers: Record<string, number> = {};
      for (const id of ids) {
        const checked = validateChannelSettings({ number: params.numbers[id] });
        if ('error' in checked) return { error: checked.error };
        numbers[id] = checked.changes.number as number;
      }
      if (Object.keys(params.numbers).some((id) => !ids.includes(id))) return { error: 'Numbers were sent for channels that aren’t in the batch.' };
      const targets = Object.values(numbers);
      if (new Set(targets).size !== targets.length) return { error: 'Two channels can’t get the same number.' };
      return { channelIds: ids, params: { operation, numbers } };
    }
    case 'repair': {
      if (!isObject(params.decisions)) return { error: 'Send a decision for each missing program.' };
      const entries = Object.entries(params.decisions);
      if (entries.length > MAX_REPAIR_DECISIONS) return { error: `Up to ${MAX_REPAIR_DECISIONS} missing programs at a time.` };
      const decisions: Record<string, RepairDecision> = {};
      for (const [programId, raw] of entries) {
        if (!CHANNEL_ID.test(programId) || !isObject(raw) || !['remove', 'flex', 'replace', 'ignore'].includes(raw.action as string)) return { error: 'Each missing program needs remove, flex, replace or ignore.' };
        if (raw.action === 'replace') {
          const rep = raw.replacement;
          // A length sent along (older pages do) is ignored: the companion asks Tunarr for the program.
          if (!isObject(rep) || typeof rep.id !== 'string' || !UUID.test(rep.id)) return { error: 'A replacement must be a program from the library.' };
          decisions[programId] = { action: 'replace', replacement: { id: rep.id.toLowerCase() } };
        } else decisions[programId] = { action: raw.action as RepairDecision['action'] };
      }
      return { channelIds: ids, params: { operation, decisions } };
    }
    default: {
      const allowed: readonly string[] = operation === 'filler' ? FILLER_FIELDS : operation === 'group' ? ['groupTitle'] : operation === 'transcode' ? ['transcodeConfigId'] : BATCH_SETTING_FIELDS;
      const raw = isObject(params.changes) ? params.changes : {};
      const keys = Object.keys(raw);
      if (!keys.length) return { error: 'Choose what to change.' };
      if (keys.some((key) => !allowed.includes(key))) return { error: `This batch can change only: ${allowed.map((key) => FIELD_LABELS[key] ?? key).join(', ')}.` };
      if (operation === 'filler' && !('fillerCollections' in raw)) return { error: 'Choose the filler lists.' };
      const checked = validateChannelSettings(raw);
      if ('error' in checked) return checked;
      return { channelIds: ids, params: { operation, changes: checked.changes } };
    }
  }
}

// ----------------------------------------------------------------- shared

type ChannelRef = { id: string; number: number; name: string };
function channelRefs(list: unknown): ChannelRef[] {
  return (Array.isArray(list) ? list : []).filter(isObject).flatMap((channel) => (typeof channel.id === 'string' && CHANNEL_ID.test(channel.id) && typeof channel.number === 'number' ? [{ id: channel.id, number: channel.number, name: String(channel.name ?? '').slice(0, 200) }] : []));
}

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

/** The fields a settings batch touches, as Tunarr has them now. */
const pick = (channel: Json, fields: readonly string[]) => Object.fromEntries(fields.map((field) => [field, channel[field] ?? null]));
/** A fingerprint of those fields: a batch only applies (or rolls back) while it still matches. */
export const settingsVersion = (values: Json) => programmingVersion(values, null);
const fieldsOf = (params: BatchParams): string[] => (params.operation === 'renumber' ? ['number'] : 'changes' in params ? Object.keys(params.changes) : []);

type Names = { lists: Map<string, string>; profiles: Map<string, string> };
/** A value as a person reads it in the preview. */
export function shown(field: string, value: unknown, names: Names): string {
  if (value === null || value === undefined) return 'not set';
  switch (field) {
    case 'fillerCollections': return Array.isArray(value) && value.length ? value.map((item) => `${names.lists.get(String((item as Json).id)) ?? 'a deleted list'}${Number((item as Json).weight) !== 1 ? ` (weight ${(item as Json).weight})` : ''}`).join(', ') : 'none';
    case 'transcodeConfigId': return names.profiles.get(String(value)) ?? 'a profile that’s gone';
    case 'onDemand': return isObject(value) && value.enabled ? 'on' : 'off';
    case 'guideMinimumDuration': case 'fillerRepeatCooldown': return `${Math.round(Number(value) / 1000)} s`;
    default:
      if (typeof value === 'boolean') return value ? 'on' : 'off';
      if (typeof value === 'string') return value ? `“${value.slice(0, 120)}”` : '(empty)';
      return String(value).slice(0, 120);
  }
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------- media repair

export type MissingProgram = { programId: string; duration: number; occurrences: Array<{ channelId: string; positions: number[]; nextAirings: number[] }> };

/** When the item at `index` airs next (up to `count` times within two weeks), walking the cycle from the channel's start. */
export function nextAirings(lineup: Json[], startTime: number, index: number, now: number, count = 3): number[] {
  const lengths = lineup.map((item) => (typeof item.duration === 'number' && item.duration > 0 ? item.duration : 0));
  const cycle = lengths.reduce((sum, value) => sum + value, 0);
  if (!cycle || !lengths[index] || !Number.isFinite(startTime)) return [];
  const offset = lengths.slice(0, index).reduce((sum, value) => sum + value, 0);
  let start = startTime + offset;
  // The first airing that hasn't ended yet.
  if (start + lengths[index] <= now) start += Math.ceil((now - lengths[index] - start + 1) / cycle) * cycle;
  const out: number[] = [];
  while (out.length < count && start < now + 14 * 86_400_000) {
    out.push(start);
    start += cycle;
  }
  return out;
}

/** Positions of content items whose program Tunarr no longer has (no details in its programming reply). */
export function missingPositions(programming: Json): Map<string, number[]> {
  const lineup = (Array.isArray(programming.lineup) ? programming.lineup : []).filter(isObject);
  const programs = isObject(programming.programs) ? programming.programs : {};
  const out = new Map<string, number[]>();
  lineup.forEach((item, index) => {
    if (item.type !== 'content' || typeof item.id !== 'string' || isObject(programs[item.id])) return;
    out.set(item.id, [...(out.get(item.id) ?? []), index]);
  });
  return out;
}

export type Replacement = { id: string; duration: number; title: string };
/** Tunarr's grouping types (a show, a season, an album…): not something a lineup item can play. */
const GROUPINGS = new Set(['show', 'season', 'artist', 'album', 'playlist', 'collection']);

/**
 * A program as Tunarr's own copy describes it, or null when it isn't one a
 * lineup can play: the id must be the one asked for, and the length Tunarr's.
 */
export function canonicalProgram(raw: unknown, id: string): Replacement | null {
  if (!isObject(raw)) return null;
  const ids = [raw.id, raw.uuid].filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase());
  if (!ids.includes(id)) return null;
  if (GROUPINGS.has(String(raw.type)) || GROUPINGS.has(String(raw.subtype))) return null;
  const duration = raw.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || !(duration > 0) || duration > MAX_ITEM_MS) return null;
  return { id, duration: Math.round(duration), title: String(raw.title ?? '').slice(0, 200) };
}

const GONE = 'A replacement program isn’t in Tunarr’s library (or can’t be played in a lineup), so nothing was changed. Choose another one and preview again.';

/**
 * Asks Tunarr for every replacement program, so what's saved is a program it
 * indexes, with its own length. Throws `replacement_unavailable` (nothing is
 * changed) when one isn't there; other failures propagate as they are.
 */
export async function resolveReplacements(config: ProxyConfig, target: TunarrTarget, decisions: Record<string, RepairDecision>): Promise<Map<string, Replacement>> {
  const ids = [...new Set(Object.values(decisions).flatMap((decision) => (decision.action === 'replace' && decision.replacement ? [decision.replacement.id] : [])))];
  const found = await bounded(ids.map((id) => async () => {
    try {
      return canonicalProgram(await callTunarr(config, target, 'GET', `/api/programs/${id}`, undefined, 'Tunarr has no such program.'), id);
    } catch (error) {
      if (error instanceof UpstreamError && (error.status === 404 || error.status === 400)) return null;
      throw error;
    }
  }), READ_CONCURRENCY);
  if (found.some((item) => !item)) throw new UpstreamError(409, 'replacement_unavailable', GONE);
  return new Map((found as Replacement[]).map((item) => [item.id, item]));
}

/** The decisions with each replacement's length from Tunarr. */
const withLengths = (decisions: Record<string, RepairDecision>, resolved: Map<string, Replacement>): Record<string, RepairDecision> => Object.fromEntries(Object.entries(decisions).map(([programId, decision]) => [programId, decision.action === 'replace' ? { action: 'replace', replacement: { id: decision.replacement!.id, duration: resolved.get(decision.replacement!.id)!.duration } } : decision]));

/**
 * What a repair is checked against at apply time: the channel's programming
 * version, plus the replacements as Tunarr described them at preview time (a
 * program whose length changed in between is a conflict, not a silent swap).
 */
export function repairExpect(version: string, resolved: Map<string, Replacement>) {
  if (!resolved.size) return version;
  return `${version}-${programmingVersion([...resolved.values()].map(({ id, duration }) => [id, duration]).sort(), null)}`;
}

/**
 * The lineup after the decisions: each missing item is removed, turned into
 * flex time of its length (so everything after keeps its time), replaced by a
 * library program, or kept. Every other item is the same object, in order.
 */
export function repairLineup(lineup: Json[], missing: Map<string, number[]>, decisions: Record<string, RepairDecision>) {
  const at = new Map<number, RepairDecision>();
  for (const [programId, positions] of missing) {
    const decision = decisions[programId];
    if (decision && decision.action !== 'ignore') for (const index of positions) at.set(index, decision);
  }
  const counts = { removed: 0, flexed: 0, replaced: 0 };
  const next: Json[] = [];
  lineup.forEach((item, index) => {
    const decision = at.get(index);
    if (!decision) return next.push(item);
    if (decision.action === 'remove') counts.removed += 1;
    else if (decision.action === 'flex') { counts.flexed += 1; next.push({ type: 'flex', duration: item.duration }); }
    else {
      // Only reached with lengths from `resolveReplacements`; never a length the browser sent.
      if (!(typeof decision.replacement?.duration === 'number' && decision.replacement.duration > 0)) throw new UpstreamError(500, 'internal_error', 'A replacement wasn’t checked with Tunarr.');
      counts.replaced += 1;
      next.push({ type: 'content', id: decision.replacement.id, duration: decision.replacement.duration });
    }
  });
  return { lineup: next, ...counts, positions: [...at.keys()].sort((a, b) => a - b) };
}

const GENERATED = 'This channel is generated from a slot schedule; saving a manual lineup would detach it from the schedule, so a batch never does. Change the schedule (or detach it) in the desk first.';

/** Tunarr refuses zero-length items, so a save leaves them out (as the desk's save does). */
const savable = (lineup: unknown[]) => lineup.filter((item) => isObject(item) && typeof item.duration === 'number' && item.duration > 0);

/** What a programming batch would save on one channel, from Tunarr's current programming. */
function plannedLineup(params: BatchParams, channelId: string, current: Json): { lineup: Json[]; summary: ProgrammingDiff } | { blocked: string } {
  const lineup = (Array.isArray(current.lineup) ? current.lineup : []).filter(isObject);
  if (current.schedule != null) return { blocked: GENERATED };
  if (params.operation === 'repair') {
    const result = repairLineup(lineup, missingPositions(current), params.decisions);
    return { lineup: result.lineup, summary: { ...importSummary(lineup, result.lineup), removed: result.removed, flexed: result.flexed, replaced: result.replaced, positions: result.positions.slice(0, 50) } };
  }
  if (params.operation === 'import') {
    const from = Object.entries(params.mapping).find(([, to]) => to === channelId)?.[0];
    const source = params.package.channels.find((channel) => channel.id === from);
    if (!source) return { blocked: 'Nothing in the package goes to this channel.' };
    const next = savable(source.lineup) as Json[];
    return { lineup: next, summary: { ...importSummary(lineup, next), removed: 0, flexed: 0, replaced: 0, positions: [] } };
  }
  return { blocked: 'Not a programming batch.' };
}

// ----------------------------------------------------------------- preview

export type ProgrammingDiff = ReturnType<typeof importSummary> & { removed: number; flexed: number; replaced: number; positions: number[] };
export type FieldChange = { field: string; label: string; before: string; after: string };
export type PreviewChannel = {
  channelId: string; number: number; name: string;
  status: 'ready' | 'unchanged' | 'blocked';
  reason?: string;
  /** What the apply checks the channel against: the fields' fingerprint, or the programming version. */
  expect?: string;
  changes?: FieldChange[];
  programming?: ProgrammingDiff;
};
export type BatchPreview = { operation: BatchOperation; label: string; channels: PreviewChannel[]; missing?: MissingProgram[]; replacements?: Replacement[] };

function batchLabel(params: BatchParams, count: number, names: Names) {
  const on = `on ${plural(count, 'channel')}`;
  switch (params.operation) {
    case 'filler': return `Filler lists → ${shown('fillerCollections', params.changes.fillerCollections, names)} ${on}`;
    case 'group': return `Group → ${shown('groupTitle', params.changes.groupTitle, names)} ${on}`;
    case 'transcode': return `Transcode profile → ${shown('transcodeConfigId', params.changes.transcodeConfigId, names)} ${on}`;
    case 'settings': return `${Object.keys(params.changes).map((key) => FIELD_LABELS[key] ?? key).join(', ')} ${on}`;
    case 'renumber': return `Renumber ${plural(count, 'channel')}`;
    case 'repair': return `Media repair ${on}`;
    case 'import': return `Import a programming package ${on}`;
  }
}

async function readNames(config: ProxyConfig, target: TunarrTarget, params: BatchParams): Promise<Names> {
  const [lists, profiles] = await Promise.all([
    params.operation === 'filler' ? callTunarr(config, target, 'GET', '/api/filler-lists').catch(() => []) : Promise.resolve([]),
    params.operation === 'transcode' ? callTunarr(config, target, 'GET', '/api/transcode_configs') : Promise.resolve([]),
  ]);
  const map = (list: unknown) => new Map((Array.isArray(list) ? list : []).filter(isObject).map((item) => [String(item.id), String(item.name ?? '')]));
  return { lists: map(lists), profiles: map(profiles) };
}

/** Channels that would end on the same number, and why each renumber is blocked. */
export function renumberProblems(all: ChannelRef[], numbers: Record<string, number>): Map<string, string> {
  const problems = new Map<string, string>();
  const finalHolder = new Map<number, ChannelRef>();
  for (const channel of all) if (!(channel.id in numbers)) finalHolder.set(channel.number, channel);
  for (const [id, number] of Object.entries(numbers)) {
    const holder = finalHolder.get(number);
    if (holder) problems.set(id, `CH ${number} is already ${holder.name || 'another channel'}, which isn’t being renumbered.`);
  }
  return problems;
}

export async function previewBatch(config: ProxyConfig, target: TunarrTarget, request: BatchRequest, now = Date.now()): Promise<BatchPreview> {
  const { params } = request;
  const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const byId = new Map(all.map((channel) => [channel.id, channel]));
  const names = await readNames(config, target, params);
  if (params.operation === 'transcode' && !names.profiles.has(String(params.changes.transcodeConfigId))) {
    throw new UpstreamError(400, 'invalid_request', 'That transcode profile no longer exists in Tunarr.');
  }
  const numberProblems = params.operation === 'renumber' ? renumberProblems(all, params.numbers) : new Map<string, string>();
  // Replacements are looked up in Tunarr before anything is planned with them.
  const resolved = params.operation === 'repair' ? await resolveReplacements(config, target, params.decisions) : new Map<string, Replacement>();
  const planParams: BatchParams = params.operation === 'repair' ? { operation: 'repair', decisions: withLengths(params.decisions, resolved) } : params;
  const fields = fieldsOf(params);
  const missing = new Map<string, MissingProgram>();

  const channels = await bounded(request.channelIds.map((channelId) => async (): Promise<PreviewChannel> => {
    const ref = byId.get(channelId);
    const base = { channelId, number: ref?.number ?? 0, name: ref?.name ?? '' };
    if (!ref) return { ...base, status: 'blocked', reason: 'Tunarr no longer has this channel.' };
    try {
      if (params.operation === 'repair' || params.operation === 'import') {
        const [programming, channel] = await Promise.all([
          callTunarr(config, target, 'GET', `/api/channels/${channelId}/programming`),
          params.operation === 'repair' ? callTunarr(config, target, 'GET', `/api/channels/${channelId}`) : Promise.resolve(null),
        ]);
        const current = isObject(programming) ? programming : {};
        const version = programmingVersion(current.lineup, current.schedule);
        const expect = params.operation === 'repair' ? repairExpect(version, resolved) : version;
        if (params.operation === 'repair') {
          const lineup = (Array.isArray(current.lineup) ? current.lineup : []).filter(isObject);
          const startTime = isObject(channel) && typeof channel.startTime === 'number' ? channel.startTime : NaN;
          for (const [programId, positions] of missingPositions(current)) {
            const entry = missing.get(programId) ?? { programId, duration: Number(lineup[positions[0]].duration) || 0, occurrences: [] };
            const airings = positions.flatMap((index) => nextAirings(lineup, startTime, index, now)).sort((a, b) => a - b).slice(0, 3);
            entry.occurrences.push({ channelId, positions: positions.slice(0, 50), nextAirings: airings });
            missing.set(programId, entry);
          }
        }
        const planned = plannedLineup(planParams, channelId, current);
        if ('blocked' in planned) return { ...base, status: 'blocked', reason: planned.blocked, expect };
        const changed = !sameValue(savable((current.lineup as unknown[]) ?? []), planned.lineup);
        return { ...base, status: changed ? 'ready' : 'unchanged', expect, programming: planned.summary };
      }
      const channel = await callTunarr(config, target, 'GET', `/api/channels/${channelId}`);
      if (!isObject(channel)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
      const before = pick(channel, fields);
      const expect = settingsVersion(before);
      if (numberProblems.has(channelId)) return { ...base, status: 'blocked', reason: numberProblems.get(channelId), expect };
      const checked = validateChannelSettings(params.operation === 'renumber' ? { number: params.numbers[channelId] } : params.changes, channel);
      if ('error' in checked) return { ...base, status: 'blocked', reason: checked.error, expect };
      const changes = fields.filter((field) => !sameValue(before[field], checked.changes[field])).map((field) => ({ field, label: FIELD_LABELS[field] ?? field, before: shown(field, before[field], names), after: shown(field, checked.changes[field], names) }));
      return { ...base, status: changes.length ? 'ready' : 'unchanged', expect, changes };
    } catch (error) {
      return { ...base, status: 'blocked', reason: `Couldn’t read it: ${failureReason(error).reason}` };
    }
  }), READ_CONCURRENCY);

  return {
    operation: params.operation,
    label: batchLabel(params, channels.filter((channel) => channel.status === 'ready').length, names),
    channels,
    ...(params.operation === 'repair' ? { missing: [...missing.values()], replacements: [...resolved.values()] } : {}),
  };
}

// ------------------------------------------------------------------- apply

/** Batches this process is applying or rolling back now (the store reports others as cut short). */
const running = new Set<string>();
export const runningBatches = () => running;

type Outcome = Pick<BatchChannel, 'status' | 'message'> & Partial<Pick<BatchChannel, 'before' | 'afterVersion' | 'snapshotId' | 'appliedVersion'>>;
/** Tunarr went away: the rest of the batch is skipped rather than each channel waiting out its own timeout. */
const stops = (error: unknown) => error instanceof UpstreamError && ['tunarr_unreachable', 'tunarr_timeout'].includes(error.code);

/** Merges `changes` onto Tunarr's copy of the channel and saves it whole. Call under the channel's lock. */
async function putChannel(config: ProxyConfig, target: TunarrTarget, channel: Json, changes: Json) {
  const next: Json = { ...channel, ...changes };
  for (const field of NOT_SAVEABLE) delete next[field];
  await callTunarr(config, target, 'PUT', `/api/channels/${String(channel.id)}`, JSON.stringify(next));
}

async function readChannel(config: ProxyConfig, target: TunarrTarget, channelId: string): Promise<Json> {
  const channel = await callTunarr(config, target, 'GET', `/api/channels/${channelId}`);
  if (!isObject(channel)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
  return channel;
}

const CHANGED = 'Changed in Tunarr since the preview, so nothing was changed here. Preview again to include it.';

async function applySettings(config: ProxyConfig, target: TunarrTarget, channelId: string, changes: Json, fields: string[], expect: string): Promise<Outcome> {
  const channel = await readChannel(config, target, channelId);
  const before = pick(channel, fields);
  if (settingsVersion(before) !== expect) return { status: 'conflict', message: CHANGED };
  const checked = validateChannelSettings(changes, channel);
  if ('error' in checked) return { status: 'blocked', message: checked.error };
  if (fields.every((field) => sameValue(before[field], checked.changes[field]))) return { status: 'unchanged', message: 'Already set.' };
  await putChannel(config, target, channel, checked.changes);
  const fresh = await readChannel(config, target, channelId);
  return { status: 'done', message: 'Saved.', before, afterVersion: settingsVersion(pick(fresh, fields)) };
}

async function applyProgramming(config: ProxyConfig, target: TunarrTarget, channelId: string, params: BatchParams, expect: string, label: string): Promise<Outcome> {
  const path = `/api/channels/${channelId}/programming`;
  const programming = await callTunarr(config, target, 'GET', path);
  const current = isObject(programming) ? programming : {};
  const version = programmingVersion(current.lineup, current.schedule);
  let planParams = params;
  if (params.operation === 'repair') {
    if (!expect.startsWith(version)) return { status: 'conflict', message: CHANGED };
    // Asked again under the lock: a program gone since the preview is never saved, and one whose length changed is a conflict.
    let resolved: Map<string, Replacement>;
    try {
      resolved = await resolveReplacements(config, target, params.decisions);
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'replacement_unavailable') return { status: 'blocked', message: GONE };
      throw error;
    }
    if (repairExpect(version, resolved) !== expect) return { status: 'conflict', message: 'A replacement program changed in Tunarr since the preview, so nothing was changed here. Preview again.' };
    planParams = { operation: 'repair', decisions: withLengths(params.decisions, resolved) };
  } else if (version !== expect) return { status: 'conflict', message: CHANGED };
  const planned = plannedLineup(planParams, channelId, current);
  if ('blocked' in planned) return { status: 'blocked', message: planned.blocked };
  if (sameValue(savable((current.lineup as unknown[]) ?? []), planned.lineup)) return { status: 'unchanged', message: 'Nothing to change.' };
  if (!planned.lineup.length) return { status: 'blocked', message: 'The result would be an empty lineup, so nothing was changed.' };
  // Unlike a single save, a batch doesn't go ahead without its snapshot: it's what a rollback restores.
  const snapshot = await config.snapshots?.take(channelId, current, `Before batch “${label.slice(0, 120)}”`);
  const snapshotId = snapshot?.id ?? (await config.snapshots?.list(channelId))?.find((item) => item.version === expect)?.id;
  if (!snapshotId) return { status: 'blocked', message: 'No snapshot could be kept first, so nothing was changed.' };
  await callTunarr(config, target, 'POST', path, JSON.stringify({ type: 'manual', lineup: planned.lineup, append: false }));
  const saved = await callTunarr(config, target, 'GET', path);
  const after = isObject(saved) ? saved : {};
  return { status: 'done', message: `Saved: ${plural(planned.summary.itemsAfter, 'item')}, ${Math.round(lineupLength(planned.lineup) / 60_000)} min a pass.`, snapshotId, appliedVersion: programmingVersion(after.lineup, after.schedule) };
}

/** Tunarr's numbers stopped matching what the renumbering expects at some step: an outside change. Nothing more is moved. */
export class RenumberConflict extends Error {
  constructor(readonly channelId: string, message: string) {
    super(message);
  }
}

/**
 * The spare number a renumbering parks a channel on while it breaks a cycle:
 * a free number inside 1..`max`, never one a channel has (`taken` holds every
 * channel's number now, the batch's own moves included) or is moving to. Just
 * above the highest when there's room, else the highest free one below; null
 * when every number is taken.
 */
export function spareNumber(taken: Iterable<number>, max = MAX_CHANNEL_NUMBER): number | null {
  const used = new Set(taken);
  const top = Math.max(0, ...used);
  if (top < max) return top + 1;
  for (let number = max; number >= 1; number -= 1) if (!used.has(number)) return number;
  return null;
}

/** One PUT of a renumbering: a channel to its new number, or parked on a spare one first. */
export type RenumberStep = { channelId: string; number: number; park: boolean };

/**
 * The order of a renumbering, worked out before anything is written: a
 * channel whose number is still held by another channel in the batch waits for
 * it to move; a cycle (two channels swapping) parks one on a spare number
 * first. `numberOf` is every channel's number now; `moves` maps channel →
 * number. Refused as a whole when a cycle needs a spare and none is free.
 */
export function planRenumber(numberOf: ReadonlyMap<string, number>, moves: ReadonlyMap<string, number>, max = MAX_CHANNEL_NUMBER): { steps: RenumberStep[] } | { error: string } {
  const numbers = new Map(numberOf);
  const pending = new Map(moves);
  const steps: RenumberStep[] = [];
  while (pending.size) {
    const holder = (number: number) => [...pending.keys()].find((id) => numbers.get(id) === number);
    const ready = [...pending.entries()].find(([id, number]) => { const held = holder(number); return !held || held === id; });
    if (!ready) {
      // Every waiting channel's number is held by another waiting one: park one on a spare number.
      const channelId = pending.keys().next().value as string;
      const spare = spareNumber([...numbers.values(), ...moves.values()], max);
      if (spare === null) return { error: `These channels swap numbers, which needs one free number from 1 to ${max.toLocaleString('en')} to pass through, and every one is taken. Nothing was moved.` };
      steps.push({ channelId, number: spare, park: true });
      numbers.set(channelId, spare);
      continue;
    }
    const [channelId, number] = ready;
    pending.delete(channelId);
    steps.push({ channelId, number, park: false });
    numbers.set(channelId, number);
  }
  return { steps };
}

/**
 * Moves channels to new numbers in the order `planRenumber` worked out, so two
 * never share one. `report` gets each channel's outcome as it happens.
 *
 * `numberOf` is the state every step expects, including the batch's own moves
 * (spare numbers too). Before each PUT, under the channel's lock, Tunarr's
 * channels are read again: if any channel in the batch isn't where the batch
 * left it, or the number about to be taken is held (a spare one too), it
 * throws RenumberConflict and nothing more is moved. Tunarr has no transaction
 * across channels, so the moves done before then stay done (and are reported
 * as such).
 */
async function moveNumbers(config: ProxyConfig, target: TunarrTarget, moves: Map<string, number>, steps: RenumberStep[], numberOf: Map<string, number>, report: (channelId: string, outcome: Outcome) => Promise<void>, before: (channelId: string) => number) {
  const parked = new Map<string, number>();
  const move = (channelId: string, number: number) => withChannelLock(channelId, async () => {
    const live = new Map(channelRefs(await callTunarr(config, target, 'GET', '/api/channels')).map((channel) => [channel.id, channel.number]));
    for (const id of moves.keys()) {
      if (live.get(id) !== numberOf.get(id)) throw new RenumberConflict(id, live.has(id) ? `CH ${numberOf.get(id)} was changed in Tunarr while renumbering (it’s CH ${live.get(id)} now), so nothing more was moved.` : 'This channel was deleted in Tunarr while renumbering, so nothing more was moved.');
    }
    const holder = [...live].find(([id, held]) => held === number && id !== channelId);
    if (holder) throw new RenumberConflict(holder[0], `CH ${number} was taken in Tunarr while renumbering, so nothing more was moved.`);
    const channel = await readChannel(config, target, channelId);
    if (channel.number !== numberOf.get(channelId)) throw new RenumberConflict(channelId, `CH ${numberOf.get(channelId)} was changed in Tunarr while renumbering, so nothing more was moved.`);
    await putChannel(config, target, channel, { number });
    numberOf.set(channelId, number);
  });
  for (const { channelId, number, park } of steps) {
    await move(channelId, number);
    if (park) {
      parked.set(channelId, number);
      continue;
    }
    parked.delete(channelId);
    await report(channelId, { status: 'done', message: `CH ${before(channelId)} → CH ${number}.`, before: { number: before(channelId) }, afterVersion: settingsVersion({ number }) });
  }
  return parked;
}

async function applyRenumber(config: ProxyConfig, target: TunarrTarget, numbers: Record<string, number>, expect: Map<string, string>, report: (channelId: string, outcome: Outcome) => Promise<void>) {
  const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const numberOf = new Map(all.map((channel) => [channel.id, channel.number]));
  const original = new Map(numberOf);
  const moves = new Map<string, number>();
  // Renumbering is planned as a whole (swaps, cycles): one channel deleted or changed since the preview stops all of it before anything moves
  // (with CH 1 ↔ CH 2 previewed and CH 2 gone, CH 1 must not take 2).
  const changed = Object.keys(numbers).find((channelId) => !numberOf.has(channelId) || settingsVersion({ number: numberOf.get(channelId) }) !== expect.get(channelId));
  if (changed) {
    const gone = !numberOf.has(changed);
    const why = gone ? 'a channel in it was deleted in Tunarr since the preview' : `CH ${original.get(changed)} changed in Tunarr since the preview`;
    for (const channelId of Object.keys(numbers)) {
      await report(channelId, channelId === changed
        ? { status: 'conflict', message: gone ? 'Deleted in Tunarr since the preview, so nothing in this renumbering was moved. Preview again.' : CHANGED }
        : { status: 'skipped', message: `Not tried: ${why}, and a renumbering goes in as a whole. Preview again.` });
    }
    return;
  }
  for (const [channelId, number] of Object.entries(numbers)) {
    if (numberOf.get(channelId) === number) await report(channelId, { status: 'unchanged', message: 'Already that number.' });
    else moves.set(channelId, number);
  }
  // A number held, after the batch, by a channel that isn't moving can't be taken.
  for (const [channelId, problem] of renumberProblems(all, Object.fromEntries(moves))) {
    moves.delete(channelId);
    await report(channelId, { status: 'blocked', message: problem });
  }
  // Planned whole before the first PUT: a swap with no spare number to pass through moves nothing.
  const plan = planRenumber(numberOf, moves);
  if ('error' in plan) {
    for (const channelId of moves.keys()) await report(channelId, { status: 'blocked', message: plan.error });
    return;
  }
  try {
    await moveNumbers(config, target, moves, plan.steps, numberOf, report, (id) => original.get(id)!);
  } catch (error) {
    if (error instanceof RenumberConflict) {
      // Stop, and say exactly what happened to each channel not yet done; never move anything back blindly.
      for (const id of [...moves.keys()].filter((key) => numberOf.get(key) !== moves.get(key))) {
        const left = numberOf.get(id)!;
        if (id === error.channelId) await report(id, { status: 'conflict', message: error.message, ...(left !== original.get(id) ? { before: { number: original.get(id) }, afterVersion: settingsVersion({ number: left }) } : {}) });
        else if (left !== original.get(id)) await report(id, { status: 'failed', message: `Stopped half way: it was left on the spare CH ${left}. ${error.message} Roll it back or renumber it by hand.`, before: { number: original.get(id) }, afterVersion: settingsVersion({ number: left }) });
        else await report(id, { status: 'skipped', message: `Not tried: ${error.message}` });
      }
      return;
    }
    // Whatever didn't move is reported by the caller; say where a channel was left.
    const stuck = [...moves.keys()].filter((id) => numberOf.get(id) !== moves.get(id));
    for (const id of stuck) {
      const left = numberOf.get(id)!;
      await report(id, { status: 'failed', message: `${failureReason(error).reason}${left !== original.get(id) ? ` It was left on CH ${left}; renumber it by hand or roll back.` : ''}`, ...(left !== original.get(id) ? { before: { number: original.get(id) }, afterVersion: settingsVersion({ number: left }) } : {}) });
    }
    throw error;
  }
}

export type ApplyRequest = BatchRequest & { expect: Map<string, string> };

const FINGERPRINT = /^[a-z0-9-]{1,80}$/i;

/**
 * Validates an apply: the batch itself plus the fingerprint each channel was
 * previewed at. Every channel it names needs one: a channel left out, or with
 * a fingerprint that isn't one, refuses the whole apply before anything is
 * recorded or written, rather than dropping that channel (an apply for A and B
 * never quietly changes only A). The per-channel parts must match the
 * channels exactly: numbers (checked by validateBatch), fingerprints, and for
 * an import the channels sent along with its mapping.
 */
export function validateApply(body: unknown): ApplyRequest | { error: string } {
  const checked = validateBatch(body);
  if ('error' in checked) return checked;
  const list = isObject(body) && isObject(body.expect) ? body.expect : null;
  if (!list) return { error: 'Preview first: send the version each channel was previewed at ("expect").' };
  const total = checked.channelIds.length;
  const missing = checked.channelIds.filter((id) => typeof list[id] !== 'string' || !FINGERPRINT.test(list[id] as string)).length;
  if (missing) return { error: `${missing === total ? (total === 1 ? 'This channel wasn’t' : 'None of these channels was') : `${missing} of the ${total} channels ${missing === 1 ? 'wasn’t' : 'weren’t'}`} previewed (or the preview didn’t come through whole), so nothing was changed. Preview again.` };
  if (Object.keys(list).some((id) => !checked.channelIds.includes(id))) return { error: 'The preview sent along names channels that aren’t in this batch, so nothing was changed. Preview again.' };
  if (checked.params.operation === 'import' && isObject(body) && body.channelIds !== undefined) {
    const sent = Array.isArray(body.channelIds) ? new Set(body.channelIds) : null;
    if (!sent || sent.size !== total || checked.channelIds.some((id) => !sent.has(id))) return { error: 'The channels don’t match where the packaged lineups go, so nothing was changed. Preview again.' };
  }
  return { ...checked, expect: new Map(checked.channelIds.map((id) => [id, list[id] as string])) };
}

/** Starts applying a batch; the record is saved after every channel, and the reply comes back at once. */
export async function startBatch(config: ProxyConfig, target: TunarrTarget, store: BatchStore, request: ApplyRequest, label: string): Promise<BatchRecord> {
  if (running.size) throw new UpstreamError(409, 'batch_running', 'Another batch is still running. Wait for it to finish.');
  const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const byId = new Map(all.map((channel) => [channel.id, channel]));
  const record = await store.create({
    operation: request.params.operation, label: label.slice(0, 200), fields: fieldsOf(request.params),
    channels: request.channelIds.map((channelId) => ({ channelId, number: byId.get(channelId)?.number ?? 0, name: byId.get(channelId)?.name ?? '', status: 'pending', message: 'Waiting…' })),
  });
  running.add(record.id);
  void runBatch(config, target, store, record, request).catch((error) => console.error('[batch]', error instanceof Error ? error.message : error)).finally(() => running.delete(record.id));
  return record;
}

async function runBatch(config: ProxyConfig, target: TunarrTarget, store: BatchStore, record: BatchRecord, request: ApplyRequest) {
  const { params } = request;
  const report = (channelId: string, outcome: Outcome) => store.update(record.id, (saved) => {
    const channel = saved.channels.find((item) => item.channelId === channelId);
    if (channel) Object.assign(channel, outcome);
  }).then(() => undefined);
  let stopped = '';
  try {
    if (params.operation === 'renumber') {
      try {
        await applyRenumber(config, target, params.numbers, request.expect, report);
      } catch (error) {
        stopped = failureReason(error).reason;
      }
    } else {
      for (const channelId of request.channelIds) {
        if (stopped) { await report(channelId, { status: 'skipped', message: `Not tried: ${stopped}` }); continue; }
        let outcome: Outcome;
        try {
          outcome = await withChannelLock(channelId, () => ('changes' in params
            ? applySettings(config, target, channelId, params.changes, record.fields, request.expect.get(channelId)!)
            : applyProgramming(config, target, channelId, params, request.expect.get(channelId)!, record.label)));
        } catch (error) {
          outcome = { status: 'failed', message: failureReason(error).reason };
          if (stops(error)) stopped = `Tunarr stopped answering (${failureReason(error).reason.replace(/\.$/, '')}).`;
        }
        await report(channelId, outcome);
      }
    }
  } finally {
    const finished = await store.update(record.id, (saved) => {
      for (const channel of saved.channels) if (channel.status === 'pending') Object.assign(channel, { status: 'skipped', message: stopped ? `Not tried: ${stopped}` : 'Not tried.' });
      saved.finishedAt = Date.now();
    });
    const counts = summarizeBatch(finished ?? record).counts;
    const troubled = (counts.conflict ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0) + (counts.blocked ?? 0);
    if (troubled) config.notifier?.notify({ event: 'batch.partial', severity: counts.failed ? 'error' : 'warning', counts: counts as Record<string, number>, summary: `A batch operation finished with ${troubled} channel${troubled === 1 ? '' : 's'} not changed (${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}). See Channel → Batch Operations → Recent batches.`, named: `“${record.label}” finished with ${troubled} channel${troubled === 1 ? '' : 's'} not changed (${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ')}).` });
  }
}

// ---------------------------------------------------------------- rollback

/**
 * Puts chosen channels back as they were before the batch, each only if it
 * still is as the batch left it (otherwise it's a conflict and stays). Settings
 * get their old values back; lineups get the snapshot taken first, saved as a
 * new conditional save after a snapshot of their own.
 */
export async function startRollback(config: ProxyConfig, target: TunarrTarget, store: BatchStore, id: string, channelIds: string[]): Promise<BatchRecord> {
  if (running.size) throw new UpstreamError(409, 'batch_running', 'Another batch is still running. Wait for it to finish.');
  const record = await store.get(id);
  if (!record) throw new UpstreamError(404, 'not_found', 'That batch is no longer kept.');
  if (!record.finishedAt) throw new UpstreamError(409, 'batch_running', 'That batch is still running.');
  const chosen = record.channels.filter((channel) => channelIds.includes(channel.channelId) && channel.rollback?.status !== 'done' && (channel.status === 'done' || (channel.status === 'failed' && channel.before)));
  if (!chosen.length) throw new UpstreamError(400, 'invalid_request', 'None of those channels has a change to roll back.');
  // Like an apply, a rollback is of exactly the channels asked for: one that can't be rolled back refuses it, rather than rolling back the rest alone.
  const others = new Set(channelIds).size - chosen.length;
  if (others) throw new UpstreamError(400, 'invalid_request', `${others} of the ${new Set(channelIds).size} channels ${others === 1 ? 'has' : 'have'} no change to roll back (or ${others === 1 ? 'it was' : 'they were'} rolled back already), so nothing was rolled back. Reload the batch and pick again.`);
  running.add(record.id);
  void runRollback(config, target, store, record, chosen).catch((error) => console.error('[batch]', error instanceof Error ? error.message : error)).finally(() => running.delete(record.id));
  return (await store.update(record.id, (saved) => {
    for (const channel of saved.channels) if (chosen.some((item) => item.channelId === channel.channelId)) channel.rollback = { status: 'skipped', message: 'Rolling back…', at: Date.now() };
  }))!;
}

async function runRollback(config: ProxyConfig, target: TunarrTarget, store: BatchStore, record: BatchRecord, chosen: BatchChannel[]) {
  const report = (channelId: string, status: NonNullable<BatchChannel['rollback']>['status'], message: string) => store.update(record.id, (saved) => {
    const channel = saved.channels.find((item) => item.channelId === channelId);
    if (channel) channel.rollback = { status, message, at: Date.now() };
  }).then(() => undefined);
  let stopped = '';
  if (record.operation === 'renumber') {
    const numberOf = new Map<string, number>();
    const moves = new Map<string, number>();
    const startedAt = new Map<string, number>();
    try {
      const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
      for (const channel of all) numberOf.set(channel.id, channel.number);
      for (const channel of chosen) {
        if (!numberOf.has(channel.channelId)) await report(channel.channelId, 'skipped', 'Tunarr no longer has this channel.');
        else if (settingsVersion({ number: numberOf.get(channel.channelId) }) !== channel.afterVersion) await report(channel.channelId, 'conflict', 'Its number changed since the batch, so it was left as it is.');
        else moves.set(channel.channelId, Number(channel.before?.number));
      }
      for (const [channelId, problem] of renumberProblems(all, Object.fromEntries(moves))) {
        moves.delete(channelId);
        await report(channelId, 'conflict', problem);
      }
      for (const id of moves.keys()) startedAt.set(id, numberOf.get(id)!);
      const plan = planRenumber(numberOf, moves);
      if ('error' in plan) {
        for (const channelId of moves.keys()) await report(channelId, 'skipped', plan.error);
      } else await moveNumbers(config, target, moves, plan.steps, numberOf, (channelId) => report(channelId, 'done', 'Back to its old number.'), (channelId) => numberOf.get(channelId)!);
    } catch (error) {
      stopped = error instanceof RenumberConflict ? error.message : failureReason(error).reason;
      // One parked on a spare number when it stopped: say where it is rather than "not tried".
      for (const [id, from] of startedAt) {
        const left = numberOf.get(id);
        if (left !== undefined && left !== from && left !== moves.get(id)) await report(id, 'failed', `Stopped half way: it was left on the spare CH ${left}. ${stopped} Renumber it by hand.`);
      }
    }
  } else {
    for (const channel of chosen) {
      if (stopped) { await report(channel.channelId, 'skipped', `Not tried: ${stopped}`); continue; }
      try {
        const [status, message] = await withChannelLock(channel.channelId, async (): Promise<[NonNullable<BatchChannel['rollback']>['status'], string]> => {
          if (record.operation === 'repair' || record.operation === 'import') {
            const path = `/api/channels/${channel.channelId}/programming`;
            const current = (await callTunarr(config, target, 'GET', path)) as Json | null;
            if (programmingVersion(current?.lineup, current?.schedule) !== channel.appliedVersion) return ['conflict', 'Its lineup changed since the batch, so it was left as it is. Restore it from File → Snapshots if needed.'];
            const snapshot = channel.snapshotId ? await config.snapshots?.get(channel.channelId, channel.snapshotId) : undefined;
            if (!snapshot) return ['failed', 'The snapshot taken before the batch is gone.'];
            await config.snapshots?.take(channel.channelId, current, `Before rolling back “${record.label.slice(0, 120)}”`);
            await callTunarr(config, target, 'POST', path, JSON.stringify({ type: 'manual', lineup: savable(snapshot.lineup), append: false }));
            return ['done', 'Restored the lineup from before the batch.'];
          }
          const live = await readChannel(config, target, channel.channelId);
          if (settingsVersion(pick(live, record.fields)) !== channel.afterVersion) return ['conflict', 'Changed since the batch, so it was left as it is.'];
          await putChannel(config, target, live, channel.before ?? {});
          return ['done', 'Back to how it was.'];
        });
        await report(channel.channelId, status, message);
      } catch (error) {
        await report(channel.channelId, 'failed', failureReason(error).reason);
        if (stops(error)) stopped = 'Tunarr stopped answering.';
      }
    }
  }
  if (stopped) {
    await store.update(record.id, (saved) => {
      for (const channel of saved.channels) if (channel.rollback?.message === 'Rolling back…') channel.rollback = { status: 'skipped', message: `Not tried: ${stopped}`, at: Date.now() };
    });
  }
}

// ------------------------------------------------------------------ export

export async function exportPackage(config: ProxyConfig, target: TunarrTarget, channelIds: string[]): Promise<ProgrammingPackage> {
  const all = channelRefs(await callTunarr(config, target, 'GET', '/api/channels'));
  const chosen = channelIds.map((id) => all.find((channel) => channel.id === id)).filter((channel): channel is ChannelRef => !!channel);
  if (!chosen.length) throw new UpstreamError(400, 'invalid_request', 'None of those channels exists.');
  const channels = await bounded(chosen.map((channel) => async () => packageChannel(channel, await callTunarr(config, target, 'GET', `/api/channels/${channel.id}/programming`))), READ_CONCURRENCY);
  return buildPackage(channels.filter((channel) => channel.lineup.length));
}

// ------------------------------------------------------------------ routes

export type BatchRoute =
  | { name: 'batch-preview' | 'batch-apply' | 'batch-export'; methods: string[] }
  | { name: 'batches'; methods: string[] }
  | { name: 'batch' | 'batch-rollback'; methods: string[]; id: string };

export function matchBatchRoute(path: string): BatchRoute | { invalid: string } | null {
  if (path === '/batch/preview') return { name: 'batch-preview', methods: ['POST'] };
  if (path === '/batch/apply') return { name: 'batch-apply', methods: ['POST'] };
  if (path === '/batch/export') return { name: 'batch-export', methods: ['POST'] };
  if (path === '/batches') return { name: 'batches', methods: ['GET'] };
  const match = /^\/batches\/([^/]+)(\/rollback)?$/.exec(path);
  if (!match) return null;
  if (!isBatchId(match[1])) return { invalid: 'Batch id is not valid.' };
  return match[2] ? { name: 'batch-rollback', methods: ['POST'], id: match[1] } : { name: 'batch', methods: ['GET'], id: match[1] };
}

export async function handleBatchRoute(route: BatchRoute, context: { config: ProxyConfig; target: TunarrTarget; body: unknown }): Promise<ProxyResponse> {
  try {
    return await batchRoute(route, context);
  } catch (error) {
    // An unreadable batches.json is reported (and never overwritten), like the other stores.
    if (error instanceof StoreError) return fail(error.status, error.code, error.message);
    throw error;
  }
}

async function batchRoute(route: BatchRoute, { config, target, body }: { config: ProxyConfig; target: TunarrTarget; body: unknown }): Promise<ProxyResponse> {
  const store = config.batches;
  if (!store) return fail(503, 'store_off', 'Batch operations aren’t available on this server.');
  switch (route.name) {
    case 'batches': return json(200, (await store.list()).map(summarizeBatch));
    case 'batch': {
      const record = await store.get(route.id);
      return record ? json(200, { ...record, running: running.has(record.id) }) : fail(404, 'not_found', 'That batch is no longer kept.');
    }
    case 'batch-preview': {
      const checked = validateBatch(body);
      if ('error' in checked) return fail(400, 'invalid_request', checked.error);
      return json(200, await previewBatch(config, target, checked));
    }
    case 'batch-apply': {
      const checked = validateApply(body);
      if ('error' in checked) return fail(400, 'invalid_request', checked.error);
      const label = isObject(body) && typeof body.label === 'string' && body.label.trim() ? body.label.trim() : `${checked.params.operation} on ${plural(checked.channelIds.length, 'channel')}`;
      return json(202, await startBatch(config, target, store, checked, label));
    }
    case 'batch-rollback': {
      const ids = isObject(body) && Array.isArray(body.channelIds) ? body.channelIds : [];
      if (!ids.length) return fail(400, 'invalid_request', 'Choose the channels to roll back.');
      if (ids.some((id) => typeof id !== 'string' || !CHANNEL_ID.test(id))) return fail(400, 'invalid_request', 'A channel id is not valid.');
      return json(202, await startRollback(config, target, store, route.id, ids));
    }
    case 'batch-export': {
      const ids = isObject(body) && Array.isArray(body.channelIds) ? [...new Set(body.channelIds)].filter((id): id is string => typeof id === 'string' && CHANNEL_ID.test(id)) : [];
      if (!ids.length) return fail(400, 'invalid_request', 'Choose the channels to export.');
      if (ids.length > MAX_PACKAGE_CHANNELS) return fail(400, 'invalid_request', `Export up to ${MAX_PACKAGE_CHANNELS} channels at a time.`);
      return json(200, await exportPackage(config, target, ids));
    }
  }
}
