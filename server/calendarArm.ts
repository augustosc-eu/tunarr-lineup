// Turning calendar entries into scheduled changes (roadmap milestone 4, D66).
// An occurrence is armed `armLeadMinutes` before it starts: the companion reads
// the channel then and plans an ordinary two-part change (the saved lineup,
// then the restore) against the version it read. If the channel is edited after
// that, the occurrence is skipped and says so, exactly like Save Later; the
// restore goes in only if nothing changed during the overlay. Arming runs on
// the scheduler's tick, so nothing happens while scheduled changes are off.
//
// Each tick first checks what's armed against the calendar as it is now
// (`reconcileCalendar`): an occurrence that hasn't started yet and is no longer
// right (its entry was edited, disabled or removed, the channel left it, or an
// entry that outranks it now overlaps it) has its plan cancelled and is armed
// again; one suppressed by an entry that no longer outranks it is armed too.
// Occurrences already on air are never touched.
//
// The calendar has one lock (`withCalendarLock`). Calendar edits hold it while
// they check, save and reconcile; arming holds it while it commits a plan (after
// checking the entry is still the one it read); and the scheduler holds it
// while it reconciles once more and applies a due calendar change
// (`calendarGuard`). So an edit lands either before a change goes in (and the
// change, no longer right, is cancelled instead) or after it (and the
// occurrence has started, so it's left alone). If reconciling fails, the
// scheduler leaves the change waiting rather than apply a plan that may be stale.
import { CALENDAR_HORIZON_MS, calendarConflicts, occurrenceKey, occurrences, outranked, startingLineup, validateCalendarEntry, type CalendarConflict, type CalendarEntryInput, type Occurrence } from './calendar.js';
import type { CalendarEntry, OccurrenceRecord } from './calendarStore.js';
import { failureReason } from './compatibility.js';
import { programmingVersion } from './lineupVersion.js';
import { CalendarCheckError, DEFAULT_GRACE_MS, validatePlan, type CalendarGuard, type ScheduledChange } from './scheduler.js';
import { StoreError } from './jsonFile.js';
import type { ProxyConfig } from './tunarrProxy.js';
import { callTunarr, UpstreamError } from './upstream.js';

const MINUTE = 60_000;
/** A restore missed while the companion was off still runs this long after the overlay's end: leaving the overlay on forever is worse than restoring late. */
const RESTORE_GRACE_MS = 7 * 86_400_000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * What an armed occurrence was planned from. Editing any of it cancels a plan
 * that hasn't started, and the occurrence is planned again once it is inside
 * its lead time: the schedule, dates and zone, how it starts and ends, the lead
 * time (shortening it from a day to 15 minutes un-arms what was armed a day
 * ahead) and the name (the plan's labels and notifications carry it). Whether
 * the entry is on, which channels it has and its priority are checked on their
 * own, per channel, so changing them re-plans only the channels they affect.
 */
export const calendarRevision = (entry: CalendarEntry) => programmingVersion({ name: entry.name, scheduleId: entry.scheduleId, recurrence: entry.recurrence, timeZone: entry.timeZone, exceptions: entry.exceptions, start: entry.start, end: entry.end, armLeadMinutes: entry.armLeadMinutes }, null);

let calendarQueue: Promise<unknown> = Promise.resolve();
/** Runs `task` alone among calendar edits, arming commits and calendar changes being applied (see above). Not re-entrant. */
export function withCalendarLock<T>(task: () => Promise<T>): Promise<T> {
  const run = calendarQueue.then(task, task);
  calendarQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** The scheduler's guard for a due calendar change: reconcile, then apply, under the calendar's lock; reconciling failing holds the change. */
export const calendarGuard = (config: ProxyConfig): CalendarGuard => (now, apply) => withCalendarLock(async () => {
  try {
    await reconcileCalendar(config, now);
  } catch (error) {
    console.error('[calendar]', error instanceof Error ? error.message : error);
    throw new CalendarCheckError('The calendar couldn’t be checked.');
  }
  return apply();
});

const when = (ms: number, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/**
 * Arms every occurrence due within its entry's lead time. Returns how many
 * were armed. Tunarr being unreachable leaves an occurrence unrecorded, so the
 * next tick tries again (until it has ended).
 */
export async function armCalendar(config: ProxyConfig, now = Date.now()): Promise<number> {
  const { target, calendar, scheduleLibrary, scheduler } = config;
  if (!target || !calendar || !scheduleLibrary || !scheduler) return 0;
  await withCalendarLock(() => reconcileCalendar(config, now));
  const entries = await calendar.list();
  const waiting = (await scheduler.store.list()).filter((change) => change.status === 'pending' && change.group === 'calendar' && change.action.kind === 'lineup');
  let armed = 0;
  let channelNames: Map<string, string> | null = null;
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const revision = calendarRevision(entry);
    // The entry as it is now, if it's still the one this run read and still covers the channel: what's recorded or planned for an older one would be stale.
    const unchanged = async (channelId: string) => {
      const current = await calendar.get(entry.id);
      return current && current.enabled && current.channelIds.includes(channelId) && calendarRevision(current) === revision ? current : undefined;
    };
    const lead = entry.armLeadMinutes * MINUTE;
    const due = occurrences(entry.recurrence, entry.timeZone, entry.exceptions, now, now + lead + 1).filter((occurrence) => occurrence.start <= now + lead);
    for (const occurrence of due) {
      for (const channelId of entry.channelIds) {
        const key = occurrenceKey(channelId, occurrence.start);
        if (entry.history.some((record) => record.key === key)) continue;
        const note = (status: OccurrenceRecord['status'], message: string, planId?: string): OccurrenceRecord => ({ key, channelId, start: occurrence.start, end: occurrence.end, status, message, at: now, ...(planId ? { planId } : {}) });
        const record = (status: OccurrenceRecord['status'], message: string, planId?: string) => withCalendarLock(async () => {
          if (await unchanged(channelId)) await calendar.record(entry.id, note(status, message, planId));
        });
        // Already planned (its record was lost): note it rather than plan it twice.
        const existing = waiting.find((change) => change.calendarId === entry.id && change.occurrence?.key === key);
        if (existing) {
          await record('armed', 'Planned.', existing.planId);
          continue;
        }
        if (outranked(entry, occurrence, channelId, entries)) {
          await record('suppressed', 'Not put in: an entry with a higher priority has this channel then.');
          continue;
        }
        const schedule = await scheduleLibrary.get(entry.scheduleId);
        if (!schedule) {
          await record('skipped', 'Not put in: its saved schedule was deleted from the library.');
          continue;
        }
        try {
          if (!channelNames) {
            const list = await callTunarr(config, target, 'GET', '/api/channels');
            channelNames = new Map((Array.isArray(list) ? list : []).filter(isObject).map((channel) => [String(channel.id), `CH ${channel.number} ${String(channel.name ?? '')}`.slice(0, 120)]));
          }
          if (!channelNames.has(channelId)) {
            await record('skipped', 'Not put in: Tunarr no longer has this channel.');
            continue;
          }
          const programming = (await callTunarr(config, target, 'GET', `/api/channels/${channelId}/programming`)) as Json | null;
          if (programming?.schedule != null) {
            await record('skipped', 'Not put in: the channel is generated from a slot schedule, and a manual lineup would detach it.');
            continue;
          }
          // Added during its own window: it joins now rather than never.
          const startsAt = Math.max(occurrence.start, now);
          const changes: unknown[] = [{
            channelId, channelName: channelNames.get(channelId), label: entry.name, at: startsAt,
            notAfter: occurrence.end !== null ? Math.max(startsAt, Math.min(occurrence.end - MINUTE, startsAt + DEFAULT_GRACE_MS)) : startsAt + DEFAULT_GRACE_MS,
            action: { kind: 'lineup', lineup: startingLineup(schedule.lineup, entry.start), expectVersion: programmingVersion(programming?.lineup, programming?.schedule), ...(entry.start.mode !== 'as-is' ? { startAt: startsAt } : {}) },
            programs: schedule.programs,
          }];
          if (occurrence.end !== null && entry.end !== 'keep') {
            changes.push({ channelId, channelName: channelNames.get(channelId), label: `${entry.name} ends`, at: occurrence.end, notAfter: occurrence.end + RESTORE_GRACE_MS, action: { kind: 'restore', after: 0, ...(entry.end === 'resume' ? { mode: 'resume' } : {}) }, programs: {} });
          }
          const plan = validatePlan({ group: 'calendar', changes }, now, await scheduler.store.list(), { calendar: true });
          if ('error' in plan) {
            await record('skipped', `Not put in: ${plan.error}`);
            continue;
          }
          const message = `Planned for ${when(startsAt, entry.timeZone)}${occurrence.end !== null && entry.end !== 'keep' ? `, back ${entry.end === 'resume' ? 'resuming' : 'as it was'} at ${when(occurrence.end, entry.timeZone)}` : ''}. It goes in only if the channel is still as it was at ${when(now, entry.timeZone)}.${startsAt > occurrence.start ? ' It joins late: the entry was added after it began.' : ''}`;
          // Committed under the calendar's lock, and only if the entry wasn't edited (or outranked) while Tunarr was read: otherwise the next run plans it from the entry as it is then.
          const committed = await withCalendarLock(async () => {
            const current = await unchanged(channelId);
            if (!current || current.history.some((item) => item.key === key) || outranked(current, occurrence, channelId, await calendar.list())) return false;
            const created = await scheduler.store.add({ ...plan, calendarId: entry.id, occurrence: { key, start: occurrence.start, end: occurrence.end, revision } });
            await calendar.record(entry.id, note('armed', message, created[0]?.planId));
            return true;
          });
          if (committed) armed += 1;
        } catch (error) {
          // Tunarr away: try again next tick.
          if (error instanceof UpstreamError && ['tunarr_unreachable', 'tunarr_timeout'].includes(error.code)) continue;
          await record('skipped', `Not put in: ${error instanceof StoreError ? error.message : failureReason(error).reason}`);
        }
      }
    }
  }
  return armed;
}

/**
 * Cancels the plans of occurrences that haven't started and are no longer
 * right, and forgets their records so the arming that follows plans them again
 * (or records them as outranked). Forgets the records of occurrences that were
 * outranked and no longer are, if they haven't started. Started occurrences
 * (their lineup change went in) are left exactly as they are. Idempotent:
 * a second run with nothing changed does nothing. Returns how many plans it
 * cancelled. Call it holding the calendar's lock; it throws when the calendar
 * or the scheduled changes can't be read or written.
 */
export async function reconcileCalendar(config: ProxyConfig, now = Date.now()): Promise<number> {
  const { calendar, scheduler } = config;
  if (!calendar || !scheduler) return 0;
  const entries = await calendar.list();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const release = new Map<string, string[]>();
  const forget = (entryId: string, key: string) => release.set(entryId, [...(release.get(entryId) ?? []), key]);
  const at = (start: number, end: number | null): Occurrence => ({ start, end, localDate: '', adjusted: false });
  let cancelled = 0;

  for (const start of (await scheduler.store.list()).filter((change) => change.group === 'calendar' && change.status === 'pending' && change.action.kind === 'lineup' && change.calendarId)) {
    const entry = byId.get(start.calendarId!);
    // Older plans have no occurrence on them; their record says which one they are.
    const record = entry?.history.find((item) => item.planId === start.planId);
    const occurrence = start.occurrence ?? (record ? { key: record.key, start: record.start, end: record.end, revision: '' } : null);
    let reason = '';
    if (!entry) reason = 'its calendar entry was removed';
    else if (!entry.enabled) reason = 'its calendar entry was turned off';
    else if (!occurrence) reason = 'it no longer matches its calendar entry';
    else if (!entry.channelIds.includes(start.channelId)) reason = 'the calendar entry no longer includes this channel';
    else if (occurrence.revision !== calendarRevision(entry)) reason = 'its calendar entry was edited';
    else if (!occurrences(entry.recurrence, entry.timeZone, entry.exceptions, occurrence.start, occurrence.start + 1).some((item) => item.start === occurrence.start && item.end === occurrence.end)) reason = 'its calendar entry no longer has this occurrence';
    else if (outranked(entry, at(occurrence.start, occurrence.end), start.channelId, entries)) reason = 'an entry with a higher priority now has this channel then';
    if (!reason) continue;
    if (await scheduler.store.cancel(start.id, `Cancelled before it started: ${reason}. The calendar plans it again if it still applies.`)) cancelled += 1;
    if (entry && occurrence) forget(entry.id, occurrence.key);
  }

  // Outranked occurrences whose winner is gone, off or lower now: armed again if they haven't started.
  for (const entry of entries) {
    if (!entry.enabled) continue;
    for (const record of entry.history) {
      if (record.status !== 'suppressed' || record.start <= now) continue;
      if (!outranked(entry, at(record.start, record.end), record.channelId, entries)) forget(entry.id, record.key);
    }
  }
  for (const [entryId, keys] of release) await calendar.release(entryId, keys);
  return cancelled;
}

/** The scheduled changes an entry's occurrences became, still waiting or running. */
async function plansOf(config: ProxyConfig, entryId: string) {
  const changes = (await config.scheduler?.store.list()) ?? [];
  const mine = changes.filter((change) => change.calendarId === entryId);
  const byPlan = new Map<string, ScheduledChange[]>();
  for (const change of mine) byPlan.set(change.planId, [...(byPlan.get(change.planId) ?? []), change]);
  return [...byPlan.values()];
}

/**
 * Ends an entry's occurrences that are on now: each one's restore is brought
 * forward to now (and still goes in only if nothing changed during the
 * overlay). Occurrences armed but not started are cancelled when `cancelArmed`.
 * Call it holding the calendar's lock, and `runEnding` after letting go of it.
 */
export async function endOccurrences(config: ProxyConfig, entryId: string, { cancelArmed }: { cancelArmed: boolean }, now = Date.now()) {
  const store = config.scheduler?.store;
  let ending = 0;
  let cancelled = 0;
  if (!store) return { ending, cancelled };
  for (const plan of await plansOf(config, entryId)) {
    const start = plan.find((change) => change.action.kind === 'lineup');
    const restore = plan.find((change) => change.action.kind === 'restore');
    if (start?.status === 'pending') {
      if (cancelArmed && (await store.cancel(start.id))) cancelled += 1;
    } else if (start?.status === 'done' && restore?.status === 'pending' && restore.at > now) {
      await store.update(restore.id, { at: now, notAfter: Math.max(restore.notAfter, now + RESTORE_GRACE_MS) });
      ending += 1;
    }
  }
  return { ending, cancelled };
}

/** Runs the restores `endOccurrences` brought forward. Only the running scheduler writes to Tunarr; while it's off, they wait for it. */
export async function runEnding(config: ProxyConfig, ending: number, now = Date.now()) {
  if (ending && config.scheduler?.enabled) await config.scheduler.runDue(now).catch(() => 0);
}

/** What a calendar edit reports about the plans it may have left stale, checked under the same lock right after it was saved. */
export async function reconcileAfterEdit(config: ProxyConfig, now = Date.now()): Promise<{ reconciled: true } | { reconciled: false; warning: string }> {
  try {
    await reconcileCalendar(config, now);
    return { reconciled: true };
  } catch (error) {
    console.error('[calendar]', error instanceof Error ? error.message : error);
    return { reconciled: false, warning: CALENDAR_UNRECONCILED };
  }
}

/** Saved, but not checked: said plainly, with a success status, so nobody sends the same entry twice. */
export const CALENDAR_UNRECONCILED = 'Saved. What was already planned from the calendar couldn’t be checked against this change just now, so nothing from the calendar goes in until it can be: the Lineup server checks again before each occurrence. There’s no need to save again.';

/** What the calendar list shows for an entry: its next occurrences and whether one is on now. */
export function entryView(entry: CalendarEntry, scheduleName: string | null, now = Date.now()) {
  const next = occurrences(entry.recurrence, entry.timeZone, entry.exceptions, now, now + CALENDAR_HORIZON_MS).slice(0, 3);
  return { ...entry, scheduleName, next, active: next.some((occurrence) => occurrence.start <= now && (occurrence.end === null || occurrence.end > now)) };
}

/**
 * Checks an entry before it's saved: valid, its schedule exists, its next
 * occurrences, and where it overlaps other entries on a shared channel. Two
 * entries of the same priority overlapping are refused; otherwise the lower
 * one is skipped on that channel while they overlap, and the preview says so.
 */
export type CalendarCheck = { entry: CalendarEntryInput; scheduleName: string; next: Occurrence[]; conflicts: CalendarConflict[]; refused: boolean; warnings: string[] };

export async function checkCalendar(config: ProxyConfig, raw: unknown, id?: string, now = Date.now()): Promise<CalendarCheck | { error: string }> {
  const entry = validateCalendarEntry(raw);
  if ('error' in entry) return { error: entry.error };
  const schedule = await config.scheduleLibrary?.get(entry.scheduleId);
  if (!schedule) return { error: 'That saved schedule is no longer in the library.' };
  const upcoming = occurrences(entry.recurrence, entry.timeZone, entry.exceptions, now, now + CALENDAR_HORIZON_MS);
  if (!upcoming.length) return { error: 'It never happens from now on (it’s over, or every date is an exception).' };
  const others = (await config.calendar?.list()) ?? [];
  const conflicts = calendarConflicts({ ...entry, id: id ?? 'new' }, others, now, now + CALENDAR_HORIZON_MS);
  const warnings: string[] = [];
  if (!config.scheduler?.enabled) warnings.push('Scheduled changes are off on the Lineup server: nothing goes in until they’re turned on (Setup → Server Settings).');
  if (entry.start.mode === 'position' && entry.start.position >= schedule.lineup.length) warnings.push(`The schedule has ${schedule.lineup.length} items, so it starts from its last one.`);
  if (upcoming.some((occurrence) => occurrence.adjusted)) warnings.push('Some times fall in an hour skipped by a clock change; they move forward to the first valid minute.');
  warnings.push('Channels generated from a slot schedule are skipped when each occurrence is armed (a manual lineup would detach them).');
  return { entry, scheduleName: schedule.name, next: upcoming.slice(0, 5), conflicts, refused: conflicts.some((conflict) => conflict.resolution === 'refused'), warnings };
}
