// Changes that go live on a date, saved by the companion with nobody at the
// desk (owner decision 2026-10-19; off unless LINEUP_SCHEDULER=on). Three kinds:
//
//   lineup   save this manual lineup (a dated save, or a seasonal overlay
//            beginning), only if the channel is still the version it was
//            planned against
//   patch    swap a few items in place (an event that airs once): the items
//            being taken out must still be there, matched by itemIdentity
//   restore  put back what a lineup change replaced (an overlay ending), only
//            if nothing has changed since that change went in
//
// Every save is conditional and runs under the channel's lock, exactly like a
// save from the desk, and a snapshot is kept first. A change whose condition
// fails is skipped and says why; nothing is forced.
import { randomUUID } from 'node:crypto';
import { withChannelLock } from './channelLock.js';
import { createJsonFile, StoreError } from './jsonFile.js';
import { lineupItemsError, slimPrograms } from './lineupItems.js';
import { itemIdentity, programmingVersion } from './lineupVersion.js';
import type { SnapshotStore } from './snapshotStore.js';
import type { ProxyConfig, TunarrTarget } from './tunarrProxy.js';
import { callTunarr, UpstreamError } from './upstream.js';

export const MAX_PENDING_CHANGES = 300;
const MAX_FINISHED_KEPT = 200;
/** How late a change may still run (the companion was off): later than this, it's skipped as missed. */
export const DEFAULT_GRACE_MS = 12 * 3_600_000;
const MAX_AHEAD_MS = 400 * 86_400_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[a-z0-9-]{1,64}$/i;
const CHANGE_ID = /^[0-9a-f-]{36}$/;

type Json = Record<string, unknown>;
type Item = Json & { type: string; duration: number };
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

export type ChangeAction =
  | { kind: 'lineup'; lineup: Item[]; expectVersion: string }
  | { kind: 'patch'; index: number; remove: string[]; insert: Item[] }
  | { kind: 'restore'; after: string };

export type ChangeStatus = 'pending' | 'done' | 'skipped' | 'failed' | 'cancelled';

export type ScheduledChange = {
  id: string;
  channelId: string;
  channelName: string;
  label: string;
  /** What kind of plan it belongs to, for the list: a dated save, an event that airs once, a seasonal overlay. */
  group: 'save' | 'event' | 'overlay';
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
};

/** The list the browser sees: the full change minus its item lists. */
export type ChangeSummary = Omit<ScheduledChange, 'action' | 'programs'> & { kind: ChangeAction['kind']; items: number };

export function summarize(change: ScheduledChange): ChangeSummary {
  const rest: Partial<ScheduledChange> = { ...change };
  delete rest.action;
  delete rest.programs;
  const { action } = change;
  return { ...(rest as Omit<ScheduledChange, 'action' | 'programs'>), kind: action.kind, items: action.kind === 'lineup' ? action.lineup.length : action.kind === 'patch' ? action.insert.length : 0 };
}

type NewChange = { channelId: string; channelName: string; label: string; at: number; notAfter?: number; action: ChangeAction; programs: Record<string, unknown> };

function validateAction(raw: unknown, ids: Set<string>): ChangeAction | { error: string } {
  if (!isObject(raw)) return { error: 'Each change needs an "action".' };
  if (raw.kind === 'lineup') {
    const problem = lineupItemsError(raw.lineup);
    if (problem) return { error: problem };
    if (!(raw.lineup as unknown[]).length) return { error: 'A scheduled lineup can’t be empty; use Reset Channel instead.' };
    if (typeof raw.expectVersion !== 'string' || !VERSION.test(raw.expectVersion)) return { error: 'Say which version of the channel this replaces ("expectVersion").' };
    return { kind: 'lineup', lineup: raw.lineup as Item[], expectVersion: raw.expectVersion };
  }
  if (raw.kind === 'patch') {
    if (!Number.isInteger(raw.index) || (raw.index as number) < 0) return { error: '"index" must be a lineup position.' };
    if (!Array.isArray(raw.remove) || raw.remove.length > 5000 || !raw.remove.every((key) => typeof key === 'string' && key.length < 400)) return { error: '"remove" must list the items being taken out.' };
    const problem = lineupItemsError(raw.insert, 'Inserted item');
    if (problem) return { error: problem };
    if (!raw.remove.length && !(raw.insert as unknown[]).length) return { error: 'The change does nothing.' };
    return { kind: 'patch', index: raw.index as number, remove: raw.remove as string[], insert: raw.insert as Item[] };
  }
  if (raw.kind === 'restore') {
    // `after` names a change in the same request (by its position) or an existing one.
    if (typeof raw.after === 'number' && Number.isInteger(raw.after)) return { kind: 'restore', after: `#${raw.after}` };
    if (typeof raw.after !== 'string' || !ids.has(raw.after)) return { error: 'A restore must follow a scheduled lineup change.' };
    return { kind: 'restore', after: raw.after };
  }
  return { error: 'Unknown kind of change.' };
}

/**
 * A plan from the browser: one change (a dated save) or two (an event that
 * airs once, an overlay with its end). `{ group, changes: [...] }`.
 */
export function validatePlan(body: unknown, now: number, existing: ScheduledChange[]): { group: ScheduledChange['group']; changes: NewChange[] } | { error: string } {
  if (!isObject(body)) return { error: 'Send { "group", "changes": [...] }.' };
  const group = body.group;
  if (group !== 'save' && group !== 'event' && group !== 'overlay') return { error: '"group" must be save, event or overlay.' };
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
    if (action.kind === 'restore' && action.after.startsWith('#')) {
      const target = changes[Number(action.after.slice(1))];
      if (!target || target.action.kind !== 'lineup') return { error: 'A restore must follow a scheduled lineup change.' };
    }
    const items = action.kind === 'lineup' ? action.lineup : action.kind === 'patch' ? action.insert : [];
    changes.push({
      channelId: raw.channelId, channelName: typeof raw.channelName === 'string' ? raw.channelName.slice(0, 120) : '', label, at: raw.at,
      notAfter: typeof raw.notAfter === 'number' ? raw.notAfter : undefined, action, programs: slimPrograms(items, raw.programs),
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
  add(plan: { group: ScheduledChange['group']; changes: NewChange[] }): Promise<ScheduledChange[]>;
  cancel(id: string): Promise<boolean>;
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
        created.push({ ...change, action, id: randomUUID(), group: plan.group, planId, notAfter: change.notAfter ?? change.at + DEFAULT_GRACE_MS, createdAt: Date.now(), status: 'pending' });
      }
      await write([...changes, ...created]);
      return created;
    }),
    cancel: (id) => file.serialize(async () => {
      const changes = await read();
      const change = changes.find((item) => item.id === id);
      if (!change || change.status !== 'pending') return false;
      // Cancelling half of a plan cancels the rest of it that hasn't run yet.
      for (const item of changes) if (item.planId === change.planId && item.status === 'pending') Object.assign(item, { status: 'cancelled', doneAt: Date.now(), message: 'Cancelled.' });
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
type Outcome = Pick<ScheduledChange, 'status' | 'message' | 'snapshotId' | 'appliedVersion'>;

const savable = (lineup: unknown[]) => lineup.filter((item) => isObject(item) && typeof item.duration === 'number' && item.duration > 0);

/** Runs one change against Tunarr. Call under the channel's lock. */
export async function applyChange(config: ProxyConfig, target: TunarrTarget, change: ScheduledChange, all: ScheduledChange[], snapshots?: SnapshotStore): Promise<Outcome> {
  const programmingPath = `/api/channels/${change.channelId}/programming`;
  const current = (await callTunarr(config, target, 'GET', programmingPath)) as Programming | null;
  const lineup = (Array.isArray(current?.lineup) ? current.lineup : []) as Item[];
  const version = programmingVersion(current?.lineup, current?.schedule);
  let next: unknown[];
  const action = change.action;
  if (action.kind === 'lineup') {
    if (version !== action.expectVersion) return { status: 'skipped', message: 'The channel changed after this was planned, so it wasn’t saved. Open the channel and plan it again.' };
    next = action.lineup;
  } else if (action.kind === 'patch') {
    const at = findPatch(lineup, action.index, action.remove);
    if (at < 0) return { status: 'skipped', message: 'The programs this change replaces are no longer where they were, so nothing was changed.' };
    next = [...lineup.slice(0, at), ...action.insert, ...lineup.slice(at + action.remove.length)];
  } else {
    const begun = all.find((item) => item.id === action.after);
    if (!begun || begun.status !== 'done' || !begun.snapshotId || !begun.appliedVersion) return { status: 'skipped', message: 'The change this undoes never went in, so there is nothing to put back.' };
    if (version !== begun.appliedVersion) return { status: 'skipped', message: `The channel was changed during “${begun.label}”, so it wasn’t put back automatically. Restore it from File → Snapshots.` };
    const snapshot = await snapshots?.get(change.channelId, begun.snapshotId);
    if (!snapshot) return { status: 'skipped', message: 'The snapshot to put back is gone, so nothing was changed.' };
    next = snapshot.lineup;
  }
  const keep = savable(next);
  if (!keep.length) return { status: 'skipped', message: 'The result would be an empty lineup, so nothing was changed.' };
  const snapshot = await snapshots?.take(change.channelId, current, `Before scheduled change “${change.label}”`).catch(() => null);
  // take() returns null when the newest snapshot already is this version; find that one.
  const snapshotId = snapshot?.id ?? (await snapshots?.list(change.channelId).catch(() => []))?.find((item) => item.version === version)?.id;
  await callTunarr(config, target, 'POST', programmingPath, JSON.stringify({ type: 'manual', lineup: keep, append: false }));
  const saved = (await callTunarr(config, target, 'GET', programmingPath)) as Programming | null;
  const skipped = next.length - keep.length;
  return {
    status: 'done',
    message: `Saved to Tunarr${skipped ? ` (${skipped} zero-length ${skipped === 1 ? 'item' : 'items'} left out)` : ''}.`,
    snapshotId,
    appliedVersion: programmingVersion(saved?.lineup, saved?.schedule),
  };
}

export type Scheduler = {
  readonly enabled: boolean;
  readonly store: SchedulerStore;
  /** Runs every change that's due. Returns how many ran (tests call this directly). */
  runDue(now?: number): Promise<number>;
  start(): void;
  stop(): void;
};

export function createScheduler(config: ProxyConfig, options: { enabled: boolean; dataDir: string; intervalMs?: number; snapshots?: SnapshotStore }): Scheduler {
  const store = createSchedulerStore(options.dataDir);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | null = null;

  async function runOnce(now: number) {
    const target = config.target;
    if (!target) return 0;
    const due = (await store.list()).filter((change) => change.status === 'pending' && change.at <= now).sort((a, b) => a.at - b.at);
    let ran = 0;
    for (const change of due) {
      if (now > change.notAfter) {
        await store.update(change.id, { status: 'skipped', doneAt: now, message: 'Missed: the Lineup server wasn’t running when this was due.' });
        continue;
      }
      let outcome: Outcome;
      try {
        // Read the list again inside the lock: a restore needs the change it undoes, as saved just before.
        outcome = await withChannelLock(change.channelId, async () => applyChange(config, target, change, await store.list(), options.snapshots));
      } catch (error) {
        const message = error instanceof UpstreamError || error instanceof StoreError ? error.message : 'Something went wrong.';
        // Tunarr unreachable: try again on the next tick until notAfter.
        if (error instanceof UpstreamError && ['tunarr_unreachable', 'tunarr_timeout'].includes(error.code) && now + (options.intervalMs ?? 30_000) <= change.notAfter) continue;
        outcome = { status: 'failed', message };
      }
      await store.update(change.id, { ...outcome, doneAt: now });
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
    enabled: options.enabled,
    store,
    runDue(now = Date.now()) {
      // One run at a time; a tick that lands mid-run waits for it.
      if (!running) running = runOnce(now).finally(() => { running = null; });
      return running;
    },
    start() {
      if (!options.enabled || timer) return;
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
