// Changes that go live on a date, saved by the companion with nobody at the
// desk (owner decision 2026-10-19; off unless LINEUP_SCHEDULER=on). Four kinds:
//
//   lineup   save this manual lineup (a dated save, or a seasonal overlay
//            beginning), only if the channel is still the version it was
//            planned against
//   patch    swap a few items in place (an event that airs once): the items
//            being taken out must still be there, matched by itemIdentity
//   restore  put back what a lineup change replaced (an overlay ending), only
//            if nothing has changed since that change went in
//   premiere add programs shortly before they start, at the boundary before
//            `startsAt` in whatever lineup the channel has then, with flex up
//            to it, keeping what's on air in place (premierePlacement); only
//            on a manual lineup
//
// Calendar occurrences (server/calendarArm.ts, D66) are lineup + restore plans
// in the "calendar" group. Their lineup change may set the channel's start
// time (so the overlay begins from its first item, or a chosen one, at the
// activation time), and its restore either puts the start time back as it was
// (the old schedule carries on as if it had kept airing) or resumes the old
// lineup where it was interrupted.
//
// A calendar change goes in only right after the calendar has been checked
// again, under the calendar's lock (the `calendarGuard`, D66): if that check
// fails, the change waits, still pending, and so does anything after it on
// the same channel; it's never applied on a plan the calendar may have
// replaced, and never failed just for that.
//
// Every save is conditional and runs under the channel's lock, exactly like a
// save from the desk, and a snapshot is kept first. A change whose condition
// fails is skipped and says why; nothing is forced. A lineup change that a
// restore will undo (a seasonal overlay, a calendar occurrence) doesn't go in
// at all without a snapshot that is written and read back: that snapshot is
// what the restore puts back, and without it the overlay would stay on for
// good. Other changes keep D50's rule (a snapshot that can't be written doesn't
// block the save).
import { randomUUID } from 'node:crypto';
import { withChannelLock } from './channelLock.js';
import { createJsonFile, StoreError } from './jsonFile.js';
import { setChannelStartTime } from './content.js';
import { lineupItemsError, slimPrograms } from './lineupItems.js';
import { itemIdentity, lineupLength, programmingVersion } from './lineupVersion.js';
import { resumedStartTime } from './calendar.js';
import { premierePlacement } from './premiere.js';
import type { SnapshotStore } from './snapshotStore.js';
import type { ProxyConfig, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, UpstreamError } from './upstream.js';
import type { Notice } from './notify.js';

export const MAX_PENDING_CHANGES = 300;
const MAX_FINISHED_KEPT = 200;
/** How late a change may still run (the companion was off): later than this, it's skipped as missed. */
export const DEFAULT_GRACE_MS = 12 * 3_600_000;
const MAX_AHEAD_MS = 400 * 86_400_000;
/** How long before its start a premiere may be planned to go in. */
export const MAX_PREMIERE_LEAD_MS = 2 * 86_400_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[a-z0-9-]{1,64}$/i;
const CHANGE_ID = /^[0-9a-f-]{36}$/;

type Json = Record<string, unknown>;
type Item = Json & { type: string; duration: number };
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

export type ChangeAction =
  /** `startAt`: move the channel's start time there once saved (the lineup then begins at that instant). */
  | { kind: 'lineup'; lineup: Item[]; expectVersion: string; startAt?: number }
  | { kind: 'patch'; index: number; remove: string[]; insert: Item[] }
  /** `mode`: exact (default: lineup and start time as they were) or resume (the old lineup carries on where it was interrupted). */
  | { kind: 'restore'; after: string; mode?: 'exact' | 'resume' }
  | { kind: 'premiere'; startsAt: number; insert: Item[] };

export type ChangeStatus = 'pending' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type ScheduledChange = {
  id: string;
  channelId: string;
  channelName: string;
  label: string;
  /** What kind of plan it belongs to, for the list: a dated save, an event that airs once, a seasonal overlay, a premiere, a calendar occurrence. */
  group: 'save' | 'event' | 'overlay' | 'premiere' | 'calendar';
  /** The calendar entry it came from (group "calendar"). */
  calendarId?: string;
  /** The calendar occurrence it is (group "calendar"): its key, times, and the entry's definition when armed (`calendarRevision`). */
  occurrence?: { key: string; start: number; end: number | null; revision: string };
  /** Links the two halves of an event or overlay. */
  planId: string;
  at: number;
  /** Not run after this (ms); defaults to at + DEFAULT_GRACE_MS. */
  notAfter: number;
  createdAt: number;
  action: ChangeAction;
  /** Titles for the programs the change adds. */
  programs: Record<string, unknown>;
  status: ChangeStatus;
  doneAt?: number;
  message?: string;
  /** Set when a lineup change went in: what it replaced, and the version it left. */
  snapshotId?: string;
  appliedVersion?: string;
  /** The channel's start time before a lineup change that may move it (calendar occurrences), for its restore. */
  previousStart?: number;
  /** Still pending, but held back on the last run: the calendar couldn't be checked first (calendar occurrences, and what follows them on the channel). */
  held?: boolean;
};

/** The list the browser sees: the full change minus its item lists. */
export type ChangeSummary = Omit<ScheduledChange, 'action' | 'programs'> & { kind: ChangeAction['kind']; items: number };

export function summarize(change: ScheduledChange): ChangeSummary {
  const rest: Partial<ScheduledChange> = { ...change };
  delete rest.action;
  delete rest.programs;
  const { action } = change;
  return { ...(rest as Omit<ScheduledChange, 'action' | 'programs'>), kind: action.kind, items: action.kind === 'lineup' ? action.lineup.length : action.kind === 'patch' || action.kind === 'premiere' ? action.insert.length : 0 };
}

type NewChange = { channelId: string; channelName: string; label: string; at: number; notAfter?: number; action: ChangeAction; programs: Record<string, unknown> };

function validateAction(raw: unknown, ids: Set<string>): ChangeAction | { error: string } {
  if (!isObject(raw)) return { error: 'Each change needs an "action".' };
  if (raw.kind === 'lineup') {
    const problem = lineupItemsError(raw.lineup);
    if (problem) return { error: problem };
    if (!(raw.lineup as unknown[]).length) return { error: 'A scheduled lineup can’t be empty; use Reset Channel instead.' };
    if (typeof raw.expectVersion !== 'string' || !VERSION.test(raw.expectVersion)) return { error: 'Say which version of the channel this replaces ("expectVersion").' };
    if (raw.startAt !== undefined && (typeof raw.startAt !== 'number' || !Number.isFinite(raw.startAt) || raw.startAt < 0)) return { error: '"startAt" must be a time.' };
    return { kind: 'lineup', lineup: raw.lineup as Item[], expectVersion: raw.expectVersion, ...(typeof raw.startAt === 'number' ? { startAt: Math.round(raw.startAt) } : {}) };
  }
  if (raw.kind === 'patch') {
    if (!Number.isInteger(raw.index) || (raw.index as number) < 0) return { error: '"index" must be a lineup position.' };
    if (!Array.isArray(raw.remove) || raw.remove.length > 5000 || !raw.remove.every((key) => typeof key === 'string' && key.length < 400)) return { error: '"remove" must list the items being taken out.' };
    const problem = lineupItemsError(raw.insert, 'Inserted item');
    if (problem) return { error: problem };
    if (!raw.remove.length && !(raw.insert as unknown[]).length) return { error: 'The change does nothing.' };
    return { kind: 'patch', index: raw.index as number, remove: raw.remove as string[], insert: raw.insert as Item[] };
  }
  if (raw.kind === 'premiere') {
    const problem = lineupItemsError(raw.insert, 'Inserted item');
    if (problem) return { error: problem };
    if (!(raw.insert as unknown[]).length) return { error: 'The change does nothing.' };
    if (typeof raw.startsAt !== 'number' || !Number.isFinite(raw.startsAt)) return { error: 'Say when the programs start ("startsAt").' };
    return { kind: 'premiere', startsAt: raw.startsAt, insert: raw.insert as Item[] };
  }
  if (raw.kind === 'restore') {
    if (raw.mode !== undefined && raw.mode !== 'exact' && raw.mode !== 'resume') return { error: 'A restore is exact or resumes.' };
    const mode = raw.mode === 'resume' ? { mode: 'resume' as const } : {};
    // `after` names a change in the same request (by its position) or an existing one.
    if (typeof raw.after === 'number' && Number.isInteger(raw.after)) return { kind: 'restore', after: `#${raw.after}`, ...mode };
    if (typeof raw.after !== 'string' || !ids.has(raw.after)) return { error: 'A restore must follow a scheduled lineup change.' };
    return { kind: 'restore', after: raw.after, ...mode };
  }
  return { error: 'Unknown kind of change.' };
}

/**
 * A plan from the browser: one change (a dated save) or two (an event that
 * airs once, an overlay with its end). `{ group, changes: [...] }`.
 */
export function validatePlan(body: unknown, now: number, existing: ScheduledChange[], { calendar = false }: { calendar?: boolean } = {}): { group: ScheduledChange['group']; changes: NewChange[] } | { error: string } {
  if (!isObject(body)) return { error: 'Send { "group", "changes": [...] }.' };
  const group = body.group;
  // Calendar plans are made by the companion itself (server/calendarArm.ts), never sent by the browser.
  if (group === 'calendar' && !calendar) return { error: 'Calendar occurrences are planned from the calendar.' };
  if (group !== 'save' && group !== 'event' && group !== 'overlay' && group !== 'premiere' && group !== 'calendar') return { error: '"group" must be save, event, overlay or premiere.' };
  if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 2) return { error: 'A plan has one or two changes.' };
  const ids = new Set(existing.filter((change) => change.action.kind === 'lineup').map((change) => change.id));
  const changes: NewChange[] = [];
  for (const raw of body.changes) {
    if (!isObject(raw)) return { error: 'Each change must be an object.' };
    if (typeof raw.channelId !== 'string' || !CHANNEL_ID.test(raw.channelId)) return { error: 'Channel id is not valid.' };
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < now - 60_000 || raw.at > now + MAX_AHEAD_MS) return { error: 'Pick a time from now to a year ahead.' };
    if (raw.notAfter !== undefined && (typeof raw.notAfter !== 'number' || raw.notAfter < raw.at)) return { error: '"notAfter" must be after the change’s time.' };
    const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : '';
    if (!label) return { error: 'Give the change a name.' };
    const action = validateAction(raw.action, ids);
    if ('error' in action) return action;
    if (group !== 'calendar' && ((action.kind === 'lineup' && action.startAt !== undefined) || (action.kind === 'restore' && action.mode))) return { error: 'Only calendar occurrences move the start time.' };
    if (action.kind === 'restore' && action.after.startsWith('#')) {
      const target = changes[Number(action.after.slice(1))];
      if (!target || target.action.kind !== 'lineup') return { error: 'A restore must follow a scheduled lineup change.' };
    }
    if (action.kind === 'premiere') {
      if (group !== 'premiere' || body.changes.length !== 1) return { error: 'A premiere is a plan of its own.' };
      if (action.startsAt < raw.at || action.startsAt - raw.at > MAX_PREMIERE_LEAD_MS) return { error: 'A premiere goes in within two days before it starts.' };
      if (typeof raw.notAfter === 'number' && raw.notAfter > action.startsAt) return { error: '"notAfter" can’t be after the premiere starts.' };
    }
    const items = action.kind === 'lineup' ? action.lineup : action.kind === 'patch' || action.kind === 'premiere' ? action.insert : [];
    changes.push({
      channelId: raw.channelId, channelName: typeof raw.channelName === 'string' ? raw.channelName.slice(0, 120) : '', label, at: raw.at,
      // A premiere that didn't go in before it starts is missed, not late.
      notAfter: typeof raw.notAfter === 'number' ? raw.notAfter : action.kind === 'premiere' ? action.startsAt : undefined, action, programs: slimPrograms(items, raw.programs),
    });
  }
  if (changes.length === 2 && changes[1].at <= changes[0].at) return { error: 'The second change must come after the first.' };
  if (changes.length === 2 && changes[0].channelId !== changes[1].channelId) return { error: 'Both changes must be for the same channel.' };
  return { group, changes };
}

/** Where `remove` sits in `lineup`: at `index` if it still matches there, else its only other match. */
export function findPatch(lineup: Item[], index: number, remove: string[]): number {
  const matchesAt = (at: number) => at >= 0 && at + remove.length <= lineup.length && remove.every((key, offset) => itemIdentity(lineup[at + offset]) === key);
  if (matchesAt(index)) return index;
  if (!remove.length) return index <= lineup.length ? index : -1;
  const found: number[] = [];
  for (let at = 0; at + remove.length <= lineup.length && found.length < 2; at += 1) if (matchesAt(at)) found.push(at);
  return found.length === 1 ? found[0] : -1;
}

export type SchedulerStore = {
  list(): Promise<ScheduledChange[]>;
  add(plan: { group: ScheduledChange['group']; changes: NewChange[]; calendarId?: string; occurrence?: ScheduledChange['occurrence'] }): Promise<ScheduledChange[]>;
  cancel(id: string, message?: string): Promise<boolean>;
  update(id: string, patch: Partial<ScheduledChange>): Promise<void>;
};

export function createSchedulerStore(dataDir: string): SchedulerStore {
  const file = createJsonFile(dataDir, 'scheduled.json', 'scheduled changes');
  const read = async (): Promise<ScheduledChange[]> => {
    const data = await file.read();
    const items = isObject(data) && Array.isArray(data.changes) ? data.changes : [];
    return items.filter((item): item is ScheduledChange => isObject(item) && typeof item.id === 'string' && isObject(item.action) && typeof item.at === 'number');
  };
  const write = (changes: ScheduledChange[]) => {
    // Keep every pending change and the most recent finished ones.
    const pending = changes.filter((change) => change.status === 'pending');
    const finished = changes.filter((change) => change.status !== 'pending').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, MAX_FINISHED_KEPT);
    return file.write({ version: 1, changes: [...pending, ...finished].sort((a, b) => a.at - b.at) });
  };
  return {
    list: () => file.serialize(read),
    add: (plan) => file.serialize(async () => {
      const changes = await read();
      if (changes.filter((change) => change.status === 'pending').length + plan.changes.length > MAX_PENDING_CHANGES) {
        throw new StoreError(409, 'too_many_changes', `Up to ${MAX_PENDING_CHANGES} changes can wait at once.`);
      }
      const planId = randomUUID();
      const created: ScheduledChange[] = [];
      for (const change of plan.changes) {
        const action = change.action.kind === 'restore' && change.action.after.startsWith('#')
          ? { kind: 'restore' as const, after: created[Number(change.action.after.slice(1))].id }
          : change.action;
        created.push({ ...change, action, id: randomUUID(), group: plan.group, planId, ...(plan.calendarId ? { calendarId: plan.calendarId } : {}), ...(plan.occurrence ? { occurrence: plan.occurrence } : {}), notAfter: change.notAfter ?? change.at + DEFAULT_GRACE_MS, createdAt: Date.now(), status: 'pending' });
      }
      await write([...changes, ...created]);
      return created;
    }),
    cancel: (id, message = 'Cancelled.') => file.serialize(async () => {
      const changes = await read();
      const change = changes.find((item) => item.id === id);
      if (!change || change.status !== 'pending') return false;
      // Cancelling half of a plan cancels the rest of it that hasn't run yet.
      for (const item of changes) if (item.planId === change.planId && item.status === 'pending') Object.assign(item, { status: 'cancelled', doneAt: Date.now(), message });
      await write(changes);
      return true;
    }),
    update: (id, patch) => file.serialize(async () => {
      const changes = await read();
      const change = changes.find((item) => item.id === id);
      if (!change) return;
      Object.assign(change, patch);
      await write(changes);
    }),
  };
}

type Programming = { lineup?: unknown; programs?: unknown; schedule?: unknown };
type Outcome = Pick<ScheduledChange, 'status' | 'message' | 'snapshotId' | 'appliedVersion' | 'previousStart'>;

const savable = (lineup: unknown[]) => lineup.filter((item) => isObject(item) && typeof item.duration === 'number' && item.duration > 0);

/** A snapshot of `current` if one can be written (D50: not a condition for the save). */
async function bestEffortSnapshot(snapshots: SnapshotStore | undefined, change: ScheduledChange, current: Programming | null, version: string) {
  const snapshot = await snapshots?.take(change.channelId, current, `Before scheduled change “${change.label}”`).catch(() => null);
  // take() returns null when the newest snapshot already is this version; find that one.
  return snapshot?.id ?? (await snapshots?.list(change.channelId).catch(() => []))?.find((item) => item.version === version)?.id;
}

/**
 * The id of a snapshot of `current` that is on disk and reads back as this
 * version, or undefined. For changes a restore will undo: only a persisted
 * snapshot survives a restart before the restore runs, so nothing held in
 * memory stands in for one.
 */
async function keptSnapshot(snapshots: SnapshotStore | undefined, change: ScheduledChange, current: Programming | null, version: string) {
  if (!snapshots) return undefined;
  try {
    const id = await bestEffortSnapshot(snapshots, change, current, version);
    const stored = id ? await snapshots.get(change.channelId, id) : undefined;
    return stored && stored.version === version && stored.lineup.length ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Runs one change against Tunarr. Call under the channel's lock. */
export async function applyChange(config: ProxyConfig, target: TunarrTarget, change: ScheduledChange, all: ScheduledChange[], snapshots?: SnapshotStore): Promise<Outcome> {
  const programmingPath = `/api/channels/${change.channelId}/programming`;
  const current = (await callTunarr(config, target, 'GET', programmingPath)) as Programming | null;
  const lineup = (Array.isArray(current?.lineup) ? current.lineup : []) as Item[];
  const version = programmingVersion(current?.lineup, current?.schedule);
  let next: unknown[];
  // Set by a premiere or a calendar occurrence: the channel start to set after the save, and a note on it.
  let startTime: number | undefined;
  let note = '';
  // A calendar occurrence keeps the start time it replaced, for its restore.
  let previousStart: number | undefined;
  const action = change.action;
  if (action.kind === 'lineup') {
    if (version !== action.expectVersion) return { status: 'skipped', message: 'The channel changed after this was planned, so it wasn’t saved. Open the channel and plan it again.' };
    if (change.group === 'calendar') {
      if (current?.schedule != null) return { status: 'skipped', message: 'This channel is generated from a slot schedule now; a manual lineup would detach it, so the occurrence wasn’t put in.' };
      const channel = (await callTunarr(config, target, 'GET', `/api/channels/${change.channelId}`)) as { startTime?: unknown } | null;
      if (typeof channel?.startTime !== 'number') return { status: 'failed', message: 'Tunarr returned an unexpected channel.' };
      previousStart = channel.startTime;
    }
    next = action.lineup;
    startTime = action.startAt;
  } else if (action.kind === 'patch') {
    const at = findPatch(lineup, action.index, action.remove);
    if (at < 0) return { status: 'skipped', message: 'The programs this change replaces are no longer where they were, so nothing was changed.' };
    next = [...lineup.slice(0, at), ...action.insert, ...lineup.slice(at + action.remove.length)];
  } else if (action.kind === 'premiere') {
    if (current?.schedule != null) return { status: 'skipped', message: 'This channel is generated from a slot schedule now, so programs can’t be added to its lineup.' };
    const channel = (await callTunarr(config, target, 'GET', `/api/channels/${change.channelId}`)) as { startTime?: unknown } | null;
    if (typeof channel?.startTime !== 'number') return { status: 'failed', message: 'Tunarr returned an unexpected channel.' };
    const added = action.insert.reduce((sum, item) => sum + item.duration, 0);
    const placement = premierePlacement(lineup, channel.startTime, Date.now(), action.startsAt, added);
    if (!placement) return { status: 'skipped', message: 'It couldn’t be placed: its start time had passed, or the channel’s lineup is empty.' };
    next = [...lineup.slice(0, placement.index), ...(placement.gap ? [{ type: 'flex', duration: placement.gap }] : []), ...action.insert, ...lineup.slice(placement.index)];
    startTime = placement.startTime;
    const late = Math.round((placement.start - action.startsAt) / 60_000);
    if (late > 0) note = ` It starts ${late} ${late === 1 ? 'minute' : 'minutes'} late: the program before it was already on.`;
  } else {
    const begun = all.find((item) => item.id === action.after);
    if (!begun || begun.status !== 'done' || !begun.appliedVersion) return { status: 'skipped', message: 'The change this undoes never went in, so there is nothing to put back.' };
    if (version !== begun.appliedVersion) return { status: 'skipped', message: `The channel was changed during “${begun.label}”, so it wasn’t put back automatically. Restore it from File → Snapshots.` };
    // It went in and the channel is still as it left it, but what it replaced can't be found: say so loudly, never "done".
    const snapshot = begun.snapshotId ? await snapshots?.get(change.channelId, begun.snapshotId).catch(() => undefined) : undefined;
    if (!snapshot) return { status: 'failed', message: `The snapshot taken before “${begun.label}” is missing, so the channel was left as “${begun.label}” set it. Restore it from File → Snapshots, or plan it by hand.` };
    next = snapshot.lineup;
    // A calendar occurrence may have moved the start time: put it back (exact), or resume where it was interrupted.
    if (begun.previousStart !== undefined) {
      startTime = action.mode === 'resume' ? resumedStartTime(begun.previousStart, lineupLength(snapshot.lineup), begun.doneAt ?? begun.at, Date.now()) : begun.previousStart;
      if (action.mode === 'resume') note = ' The old lineup picks up where it was interrupted.';
    }
  }
  const keep = savable(next);
  if (!keep.length) return { status: 'skipped', message: 'The result would be an empty lineup, so nothing was changed.' };
  const restoreFollows = action.kind === 'lineup' && all.some((item) => item.planId === change.planId && item.status === 'pending' && item.action.kind === 'restore' && item.action.after === change.id);
  const snapshotId = restoreFollows ? await keptSnapshot(snapshots, change, current, version) : await bestEffortSnapshot(snapshots, change, current, version);
  if (restoreFollows && !snapshotId) return { status: 'failed', message: 'No snapshot of the programming it replaces could be kept, so nothing was saved: without one it couldn’t be put back when it ends.' };
  await callTunarr(config, target, 'POST', programmingPath, JSON.stringify({ type: 'manual', lineup: keep, append: false }));
  if (startTime !== undefined) {
    const kept = startTime;
    // Saved first, like the desk: if the start can't move, it's an ordinary save and says so.
    try {
      await setChannelStartTime(config, target, change.channelId, () => kept);
    } catch (error) {
      note += ` The start time didn’t move, so programs around it shifted: ${error instanceof UpstreamError ? error.message : 'Tunarr did not accept it.'}`;
    }
  }
  const saved = (await callTunarr(config, target, 'GET', programmingPath)) as Programming | null;
  const skipped = next.length - keep.length;
  return {
    status: 'done',
    message: `Saved to Tunarr${skipped ? ` (${skipped} zero-length ${skipped === 1 ? 'item' : 'items'} left out)` : ''}.${note}`,
    snapshotId,
    appliedVersion: programmingVersion(saved?.lineup, saved?.schedule),
    ...(previousStart !== undefined ? { previousStart } : {}),
  };
}

const OUTCOME_WORDS = { done: ['scheduled.applied', 'info', 'went in'], skipped: ['scheduled.skipped', 'warning', 'was skipped'], failed: ['scheduled.failed', 'error', 'failed'], missed: ['scheduled.missed', 'warning', 'was missed (the Lineup server wasn’t running)'] } as const;

/** What a notification says about a scheduled change (no reasons: they can name Tunarr's host). */
export function scheduledNotice(change: ScheduledChange, outcome: keyof typeof OUTCOME_WORDS): Notice {
  const [event, severity, words] = OUTCOME_WORDS[outcome];
  const kind = change.group === 'calendar' ? 'A calendar occurrence' : 'A scheduled change';
  return {
    event, severity, channel: { id: change.channelId, name: change.channelName },
    summary: `${kind} ${words}${outcome === 'done' ? '' : '. See File → Scheduled Changes in the desk for why'}.`,
    named: `“${change.label}” ${words} on ${change.channelName || 'a channel'}${outcome === 'done' ? '' : '. See File → Scheduled Changes for why'}.`,
  };
}

/**
 * Thrown by the calendar guard when what's armed couldn't be checked against
 * the calendar as it is now: the change waits (it's never applied on a stale
 * plan, and never failed for it), and the next run tries again.
 */
export class CalendarCheckError extends Error {}

/** Runs `apply` once the calendar has been reconciled, holding the calendar's lock (server/calendarArm.ts). */
export type CalendarGuard = <T>(now: number, apply: () => Promise<T>) => Promise<T>;

const HELD_CALENDAR = 'Waiting: the calendar couldn’t be checked just before this was due, so it wasn’t put in yet. It’s tried again on the next run.';
const HELD_BEHIND = 'Waiting: a calendar occurrence due before it on this channel is waiting, so this goes in after it.';

export type Scheduler = {
  readonly enabled: boolean;
  /** Turns it on or off while running (Server Settings). */
  setEnabled(on: boolean): void;
  readonly store: SchedulerStore;
  /** Runs every change that's due. Returns how many ran (tests call this directly). */
  runDue(now?: number): Promise<number>;
  start(): void;
  stop(): void;
};

export function createScheduler(config: ProxyConfig, options: { enabled: boolean; dataDir: string; intervalMs?: number; snapshots?: SnapshotStore; arm?: (now: number) => Promise<unknown>; calendarGuard?: CalendarGuard }): Scheduler {
  const store = createSchedulerStore(options.dataDir);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | null = null;
  let enabled = options.enabled;

  async function runOnce(now: number) {
    const target = config.target;
    if (!target) return 0;
    // Calendar occurrences coming up become ordinary changes first, so one that's due runs in this same tick.
    // Arming failing is only logged: every calendar change below is still checked against the calendar before it goes in.
    await options.arm?.(now).catch((error) => console.error('[calendar]', error instanceof Error ? error.message : error));
    const due = (await store.list()).filter((change) => change.status === 'pending' && change.at <= now).sort((a, b) => a.at - b.at);
    // Channels whose calendar change is waiting: what comes after it there waits too, so nothing goes in out of order.
    const held = new Set<string>();
    const hold = async (change: ScheduledChange, message: string) => {
      held.add(change.channelId);
      if (!change.held || change.message !== message) await store.update(change.id, { held: true, message });
    };
    let ran = 0;
    for (const change of due) {
      if (now > change.notAfter) {
        await store.update(change.id, { status: 'skipped', doneAt: now, held: undefined, message: change.held ? 'Not put in: it was still waiting for the calendar to be checked when its time ran out.' : 'Missed: the Lineup server wasn’t running when this was due.' });
        config.notifier?.notify(scheduledNotice(change, change.held ? 'skipped' : 'missed'));
        continue;
      }
      if (held.has(change.channelId)) {
        await hold(change, HELD_BEHIND);
        continue;
      }
      let outcome: Outcome | null;
      try {
        // Read the change again inside the lock: it may have been cancelled (or re-planned by the calendar) since the list above,
        // and a restore needs the change it undoes, as saved just before.
        const apply = () => withChannelLock(change.channelId, async () => {
          const all = await store.list();
          const fresh = all.find((item) => item.id === change.id);
          return fresh?.status === 'pending' ? applyChange(config, target, fresh, all, options.snapshots) : null;
        });
        if (change.group !== 'calendar') outcome = await apply();
        else if (!options.calendarGuard) throw new CalendarCheckError('No calendar to check against.');
        else outcome = await options.calendarGuard(now, apply);
      } catch (error) {
        // The calendar couldn't be reconciled: the change waits, pending, for a run where it can be.
        if (error instanceof CalendarCheckError) {
          await hold(change, HELD_CALENDAR);
          continue;
        }
        const message = error instanceof UpstreamError || error instanceof StoreError ? error.message : 'Something went wrong.';
        // Tunarr unreachable: try again on the next tick until notAfter.
        if (error instanceof UpstreamError && ['tunarr_unreachable', 'tunarr_timeout'].includes(error.code) && now + (options.intervalMs ?? 30_000) <= change.notAfter) continue;
        outcome = { status: 'failed', message };
      }
      // Cancelled (or re-planned) while it waited: nothing to record.
      if (!outcome) continue;
      await store.update(change.id, { ...outcome, doneAt: now, held: undefined });
      if (outcome.status === 'done' || outcome.status === 'skipped' || outcome.status === 'failed') config.notifier?.notify(scheduledNotice(change, outcome.status));
      if (outcome.status !== 'done') {
        // Nothing to undo when the first half didn't go in.
        for (const other of (await store.list()).filter((item) => item.planId === change.planId && item.status === 'pending' && item.action.kind === 'restore')) {
          await store.update(other.id, { status: 'skipped', doneAt: now, message: 'Skipped because the change before it didn’t go in.' });
        }
      }
      ran += 1;
    }
    return ran;
  }

  const scheduler: Scheduler = {
    get enabled() { return enabled; },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) scheduler.start();
      else scheduler.stop();
    },
    store,
    runDue(now = Date.now()) {
      // One run at a time; a tick that lands mid-run waits for it.
      if (!running) running = runOnce(now).finally(() => { running = null; });
      return running;
    },
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => { scheduler.runDue().catch((error) => console.error('[scheduler]', error instanceof Error ? error.message : error)); }, options.intervalMs ?? 30_000);
      timer.unref?.();
      void scheduler.runDue().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return scheduler;
}

export const isChangeId = (value: string) => CHANGE_ID.test(value);
