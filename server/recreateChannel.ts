import { NOT_SAVEABLE } from './content.js';
import { programmingVersion } from './lineupVersion.js';
import { UpstreamError } from './upstream.js';

// Tunarr's API has no way to drop a slot schedule: a manual save replaces only
// the items, and a channel copy carries the schedule along. The only clean way
// to make a scheduled channel manual (or empty for good) is a fresh channel with
// the same settings, so this module recreates it:
//
//   1. create a channel from the old one's own fields, on a free number
//   2. save the lineup to it (the current one, or none)
//   3. delete the old channel
//   4. move the new one to the old number
//
// Until step 3 the old channel is untouched, and a failure removes the new one.
// Tunarr gives the new channel a new id, and deleting the old one turns other
// channels' redirects to it into off-air time, so `redirectsTo` lets the UI name
// those channels before anyone confirms.

type Json = Record<string, unknown>;
export type Call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => Promise<unknown>;
export type RecreateMode = 'keep' | 'empty';
export type ChannelRef = { id: string; number: number; name: string };
export type RecreateResult = ChannelRef & { previousId: string; numberError?: string };

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

export function validateRecreate(body: unknown): { lineup: RecreateMode } | { error: string } {
  if (!isObject(body)) return { error: 'Request body must be a JSON object.' };
  if (Object.keys(body).some((key) => key !== 'lineup')) return { error: 'Only "lineup" can be sent.' };
  if (body.lineup !== 'keep' && body.lineup !== 'empty') return { error: '"lineup" must be "keep" or "empty".' };
  return { lineup: body.lineup };
}

/** True when a lineup item or schedule slot sends viewers to `channelId`. */
export function redirectsTo(programming: unknown, channelId: string): boolean {
  if (!isObject(programming)) return false;
  const items = Array.isArray(programming.lineup) ? programming.lineup : [];
  if (items.some((item) => isObject(item) && item.type === 'redirect' && item.channel === channelId)) return true;
  const slots = isObject(programming.schedule) && Array.isArray(programming.schedule.slots) ? programming.schedule.slots : [];
  return slots.some((slot) => isObject(slot) && slot.type === 'redirect' && slot.channelId === channelId);
}

function channelRefs(list: unknown): ChannelRef[] {
  return (Array.isArray(list) ? list : []).filter(isObject).flatMap((channel) =>
    typeof channel.id === 'string' && typeof channel.number === 'number' ? [{ id: channel.id, number: channel.number, name: String(channel.name ?? '') }] : []);
}

/** Other channels whose lineup or slot schedule redirects to `channelId`. */
export async function findRedirectsTo(call: Call, channelId: string): Promise<ChannelRef[]> {
  const others = channelRefs(await call('GET', '/api/channels')).filter((channel) => channel.id !== channelId);
  const found: ChannelRef[] = [];
  // A few at a time: each read returns a whole lineup.
  for (let start = 0; start < others.length; start += 4) {
    const batch = others.slice(start, start + 4);
    const reads = await Promise.all(batch.map((channel) => call('GET', `/api/channels/${channel.id}/programming`).catch(() => null)));
    batch.forEach((channel, index) => { if (redirectsTo(reads[index], channelId)) found.push(channel); });
  }
  return found.sort((a, b) => a.number - b.number);
}

/** Channels a programming's lineup items or redirect slots send viewers to. */
export function redirectTargets(programming: unknown): string[] {
  if (!isObject(programming)) return [];
  const targets = new Set<string>();
  for (const item of Array.isArray(programming.lineup) ? programming.lineup : []) if (isObject(item) && item.type === 'redirect' && typeof item.channel === 'string') targets.add(item.channel);
  const slots = isObject(programming.schedule) && Array.isArray(programming.schedule.slots) ? programming.schedule.slots : [];
  for (const slot of slots) if (isObject(slot) && slot.type === 'redirect' && typeof slot.channelId === 'string') targets.add(slot.channelId);
  return [...targets];
}

/**
 * Every redirect between channels, for spotting loops (A → B → A, which
 * Tunarr can't resolve) and redirects to channels that are gone. Reads each
 * channel's programming, a few at a time, so it's run on request only.
 */
export async function redirectEdges(call: Call): Promise<Array<{ from: string; to: string }>> {
  const channels = channelRefs(await call('GET', '/api/channels'));
  const edges: Array<{ from: string; to: string }> = [];
  for (let start = 0; start < channels.length; start += 4) {
    const batch = channels.slice(start, start + 4);
    const reads = await Promise.all(batch.map((channel) => call('GET', `/api/channels/${channel.id}/programming`).catch(() => null)));
    batch.forEach((channel, index) => { for (const to of redirectTargets(reads[index])) edges.push({ from: channel.id, to }); });
  }
  return edges;
}

/** The old channel's fields as a create request (Tunarr assigns the id). */
function saveable(channel: Json, number: number): Json {
  const next: Json = { ...channel, number };
  for (const field of NOT_SAVEABLE) delete next[field];
  return next;
}

/**
 * Recreates `channelId` without its slot schedule. `expectedVersion` is the
 * programming version the user saw; call this under the channel's lock.
 */
export async function recreateChannel(call: Call, channelId: string, mode: RecreateMode, expectedVersion: string): Promise<RecreateResult> {
  const current = (await call('GET', `/api/channels/${channelId}/programming`)) as { lineup?: unknown; schedule?: unknown } | null;
  if (programmingVersion(current?.lineup, current?.schedule) !== expectedVersion) {
    throw new UpstreamError(412, 'lineup_changed', 'This channel changed in Tunarr since it was loaded. Nothing was changed.');
  }
  const channel = await call('GET', `/api/channels/${channelId}`);
  if (!isObject(channel) || typeof channel.number !== 'number' || typeof channel.name !== 'string') {
    throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
  }
  const number = channel.number;
  const spare = channelRefs(await call('GET', '/api/channels')).reduce((max, item) => Math.max(max, item.number), 0) + 1;
  // Items are passed through untouched (invariant 3); Tunarr refuses zero-length ones.
  const lineup = mode === 'keep' && Array.isArray(current?.lineup)
    ? current.lineup.filter((item) => isObject(item) && typeof item.duration === 'number' && item.duration > 0)
    : [];

  const created = await call('POST', '/api/channels', { type: 'new', channel: saveable(channel, spare) });
  const newId = isObject(created) && typeof created.id === 'string' ? created.id : '';
  if (!newId) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr did not return the new channel. Nothing else was changed.');
  try {
    if (lineup.length) await call('POST', `/api/channels/${newId}/programming`, { type: 'manual', lineup, append: false });
    await call('DELETE', `/api/channels/${channelId}`);
  } catch (error) {
    // The old channel is still whole; take the half-made copy away again.
    await call('DELETE', `/api/channels/${newId}`).catch(() => {});
    if (error instanceof UpstreamError) throw new UpstreamError(error.status, error.code, `${error.message} The channel was left as it was.`);
    throw error;
  }

  const result: RecreateResult = { id: newId, number, name: channel.name, previousId: channelId };
  try {
    const fresh = await call('GET', `/api/channels/${newId}`);
    if (!isObject(fresh)) throw new UpstreamError(502, 'tunarr_invalid_response', 'Tunarr returned an unexpected channel.');
    await call('PUT', `/api/channels/${newId}`, saveable(fresh, number));
  } catch (error) {
    result.number = spare;
    result.numberError = `The channel was recreated as ${spare}, but couldn’t move back to ${number}: ${error instanceof UpstreamError ? error.message : 'Tunarr refused.'} Change its number in Channel Settings.`;
  }
  return result;
}
