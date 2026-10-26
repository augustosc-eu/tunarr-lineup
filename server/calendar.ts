// The programming calendar (roadmap milestone 4, D66): when a saved schedule
// from the library goes on which channels, and what happens when it ends.
// Pure (no Node APIs), so the desk previews occurrences and conflicts with the
// same code the companion arms them with. Time zones are explicit IANA names,
// worked out with Intl; local times that don't exist (the hour skipped when
// clocks go forward) move forward to the first valid minute, and ambiguous ones
// (the hour repeated when clocks go back) take the first of the two.

export type LocalDateTime = { date: string; time: string };
export type MonthDayTime = { month: number; day: number; time: string };

export type Recurrence =
  /** One activation: from `start`, until `end` (or kept, with no end). Also a one-time date range. */
  | { kind: 'once'; start: LocalDateTime; end: LocalDateTime | null }
  /** Every year, from a month/day to another (it may wrap past New Year). */
  | { kind: 'yearly'; start: MonthDayTime; end: MonthDayTime }
  /** On some weekdays (0 = Sunday), from a time to another (past midnight when the end is earlier). */
  | { kind: 'weekly'; weekdays: number[]; start: string; end: string };

/**
 * How the overlay begins. `as-is`: the lineup goes in wherever the channel's
 * cycle lands (like Save Later); `restart`: it starts from its first item at
 * the activation time; `position`: from item `position` (0-based) then.
 */
export type StartMode = { mode: 'as-is' } | { mode: 'restart' } | { mode: 'position'; position: number };
/**
 * When it ends. `restore`: the lineup and start time from before, exactly, so
 * the old schedule carries on as if it had kept airing; `resume`: the old
 * lineup picks up where it was interrupted (its start time moves later by the
 * overlay's length); `keep`: nothing changes at the end.
 */
export type EndBehavior = 'restore' | 'resume' | 'keep';

export type CalendarEntryInput = {
  name: string;
  scheduleId: string;
  channelIds: string[];
  recurrence: Recurrence;
  timeZone: string;
  exceptions: string[];
  priority: number;
  start: StartMode;
  end: EndBehavior;
  /** How long before each occurrence it's armed (planned against the lineup the channel has then). */
  armLeadMinutes: number;
  enabled: boolean;
};

export type Occurrence = { start: number; end: number | null; localDate: string; adjusted: boolean };

export const MAX_CALENDAR_CHANNELS = 20;
export const MAX_EXCEPTIONS = 60;
export const DEFAULT_ARM_LEAD_MINUTES = 6 * 60;
/** How far ahead occurrences are looked for (conflicts, the list). */
export const CALENDAR_HORIZON_MS = 400 * 86_400_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 86_400_000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------- time zones

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    formatters.set(timeZone, format);
  }
  return format;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock in `timeZone` at instant `ms`. */
export function wallClock(ms: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return { year, month, day, hour, minute, weekday: WEEKDAYS.indexOf(parts.weekday), asUtc: Date.UTC(year, month - 1, day, hour, minute, Number(parts.second)) };
}

/** Milliseconds the zone is ahead of UTC at instant `ms`. */
export const offsetAt = (ms: number, timeZone: string) => wallClock(ms, timeZone).asUtc - Math.floor(ms / 1000) * 1000;

/**
 * The instant a local wall-clock time happens in `timeZone`. A time skipped by
 * a clock change moves forward by the gap (02:30 on a spring-forward night is
 * 03:30); a repeated one takes the first (01:30 on a fall-back night is the
 * earlier 01:30). `adjusted` says the time didn't exist as written.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): { at: number; adjusted: boolean } {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY / 2, timeZone);
  const after = offsetAt(wall + DAY / 2, timeZone);
  const candidates = [...new Set([wall - before, wall - after])].filter((at) => wallClock(at, timeZone).asUtc === wall).sort((a, b) => a - b);
  if (candidates.length) return { at: candidates[0], adjusted: false };
  // In the gap: the instant that keeps the earlier offset lands just past it.
  return { at: wall - before, adjusted: true };
}

/**
 * Every instant a local date and time happens at: one usually; two in an hour
 * the clocks repeat (earlier first); in a skipped hour, the instant zonedTime
 * moves it to.
 */
export function zonedInstants(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const found = [...new Set([wall - offsetAt(wall - DAY / 2, timeZone), wall - offsetAt(wall + DAY / 2, timeZone)])].filter((at) => wallClock(at, timeZone).asUtc === wall).sort((a, b) => a - b);
  return found.length ? found : [zonedTime(year, month, day, hour, minute, timeZone).at];
}

export function localDate(ms: number, timeZone: string) {
  const clock = wallClock(ms, timeZone);
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

const parseTime = (time: string) => { const [hour, minute] = time.split(':').map(Number); return { hour, minute }; };
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// --------------------------------------------------------------- occurrences

/**
 * Occurrences that are on at some point in [from, to): their start and end
 * instants (end null: kept, no end), and the local date each starts on (what
 * exceptions name). A yearly date past the end of a month (29 February) falls
 * on the month's last day.
 */
export function occurrences(recurrence: Recurrence, timeZone: string, exceptions: string[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  const skip = new Set(exceptions);
  const add = (start: { at: number; adjusted: boolean }, end: { at: number; adjusted: boolean } | null) => {
    if (end && end.at <= start.at) return;
    if (start.at >= to || (end && end.at <= from)) return;
    const date = localDate(start.at, timeZone);
    if (skip.has(date)) return;
    out.push({ start: start.at, end: end ? end.at : null, localDate: date, adjusted: start.adjusted || !!end?.adjusted });
  };
  if (recurrence.kind === 'once') {
    const [, y, m, d] = DATE.exec(recurrence.start.date)!.map(Number);
    const { hour, minute } = parseTime(recurrence.start.time);
    const start = zonedTime(y, m, d, hour, minute, timeZone);
    let end = null;
    if (recurrence.end) {
      const [, ey, em, ed] = DATE.exec(recurrence.end.date)!.map(Number);
      const endTime = parseTime(recurrence.end.time);
      end = zonedTime(ey, em, ed, endTime.hour, endTime.minute, timeZone);
    }
    add(start, end);
  } else if (recurrence.kind === 'yearly') {
    const first = wallClock(from, timeZone).year - 1;
    const last = wallClock(to, timeZone).year;
    const { start, end } = recurrence;
    const wraps = end.month < start.month || (end.month === start.month && (end.day < start.day || (end.day === start.day && end.time <= start.time)));
    for (let year = first; year <= last; year += 1) {
      const s = parseTime(start.time);
      const e = parseTime(end.time);
      const endYear = wraps ? year + 1 : year;
      add(
        zonedTime(year, start.month, Math.min(start.day, daysIn(year, start.month)), s.hour, s.minute, timeZone),
        zonedTime(endYear, end.month, Math.min(end.day, daysIn(endYear, end.month)), e.hour, e.minute, timeZone),
      );
    }
  } else {
    const s = parseTime(recurrence.start);
    const e = parseTime(recurrence.end);
    const overnight = recurrence.end <= recurrence.start;
    // Walk local calendar days (a day can be 23 or 25 hours long around a clock change).
    let clock = wallClock(from - 2 * DAY, timeZone);
    for (let step = 0; step < 800; step += 1) {
      const dayStart = zonedTime(clock.year, clock.month, clock.day, 0, 0, timeZone).at;
      if (dayStart >= to) break;
      const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
      if (recurrence.weekdays.includes(weekday)) {
        const next = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + (overnight ? 1 : 0)));
        add(zonedTime(clock.year, clock.month, clock.day, s.hour, s.minute, timeZone), zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), e.hour, e.minute, timeZone));
      }
      const tomorrow = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + 1));
      clock = { ...clock, year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() };
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ conflicts

export type CalendarConflict = {
  channelId: string;
  otherId: string;
  otherName: string;
  /** When the two overlap. */
  start: number;
  end: number | null;
  /** refused: same priority, one must change; this-wins / other-wins: the lower one is skipped on that channel then. */
  resolution: 'refused' | 'this-wins' | 'other-wins';
};

type ConflictEntry = Pick<CalendarEntryInput, 'channelIds' | 'recurrence' | 'timeZone' | 'exceptions' | 'priority' | 'enabled'> & { id: string; name: string; createdAt?: number };

const overlap = (a: Occurrence, b: Occurrence) => {
  const start = Math.max(a.start, b.start);
  const end = a.end === null ? b.end : b.end === null ? a.end : Math.min(a.end, b.end);
  return end === null || end > start ? { start, end } : null;
};

/** Where `entry` overlaps other entries on a shared channel within [from, to), and who wins. */
export function calendarConflicts(entry: ConflictEntry, others: ConflictEntry[], from: number, to: number): CalendarConflict[] {
  const conflicts: CalendarConflict[] = [];
  const mine = occurrences(entry.recurrence, entry.timeZone, entry.exceptions, from, to);
  for (const other of others) {
    if (other.id === entry.id || !other.enabled) continue;
    const shared = entry.channelIds.filter((id) => other.channelIds.includes(id));
    if (!shared.length) continue;
    const theirs = occurrences(other.recurrence, other.timeZone, other.exceptions, from, to);
    for (const a of mine) {
      for (const b of theirs) {
        const both = overlap(a, b);
        if (!both) continue;
        const resolution = entry.priority === other.priority ? 'refused' : entry.priority > other.priority ? 'this-wins' : 'other-wins';
        for (const channelId of shared) conflicts.push({ channelId, otherId: other.id, otherName: other.name, start: both.start, end: both.end, resolution });
      }
    }
  }
  return conflicts.sort((a, b) => a.start - b.start);
}

/**
 * Whether `a` takes a shared channel from `b` where they overlap: the higher
 * priority wins. Equal priorities overlapping are refused when saving, but can
 * still meet (entries saved before a check, a priority edited on the other
 * side); then the older entry wins, and the lower id after that, so the answer
 * never depends on the order entries are read in.
 */
export function outranks(a: ConflictEntry, b: ConflictEntry) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  const ageA = a.createdAt ?? 0;
  const ageB = b.createdAt ?? 0;
  if (ageA !== ageB) return ageA < ageB;
  return a.id < b.id;
}

/** True when an entry that outranks this one has an occurrence overlapping `occurrence` on `channelId` (so this one is skipped there). */
export function outranked(entry: ConflictEntry, occurrence: Occurrence, channelId: string, others: ConflictEntry[]) {
  return others.some((other) => other.id !== entry.id && other.enabled && outranks(other, entry) && other.channelIds.includes(channelId)
    && occurrences(other.recurrence, other.timeZone, other.exceptions, occurrence.start, occurrence.end ?? occurrence.start + CALENDAR_HORIZON_MS).some((theirs) => overlap(occurrence, theirs)));
}

// ----------------------------------------------------------------- validation

const validDate = (value: unknown): value is string => {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
};
const validTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);
const validMonthDay = (value: unknown): value is MonthDayTime => isObject(value) && Number.isInteger(value.month) && (value.month as number) >= 1 && (value.month as number) <= 12
  && Number.isInteger(value.day) && (value.day as number) >= 1 && (value.day as number) <= daysIn(2024, value.month as number) && validTime(value.time);

function validateRecurrence(raw: unknown): Recurrence | { error: string } {
  if (!isObject(raw)) return { error: 'Say when it happens.' };
  if (raw.kind === 'once') {
    const start = raw.start;
    if (!isObject(start) || !validDate(start.date) || !validTime(start.time)) return { error: 'Give a start date and time.' };
    if (raw.end === null || raw.end === undefined) return { kind: 'once', start: { date: start.date, time: start.time }, end: null };
    const end = raw.end;
    if (!isObject(end) || !validDate(end.date) || !validTime(end.time)) return { error: 'Give an end date and time, or keep it with no end.' };
    if (`${end.date}T${end.time}` <= `${start.date}T${start.time}`) return { error: 'The end must be after the start.' };
    return { kind: 'once', start: { date: start.date, time: start.time }, end: { date: end.date, time: end.time } };
  }
  if (raw.kind === 'yearly') {
    if (!validMonthDay(raw.start) || !validMonthDay(raw.end)) return { error: 'Give the month, day and time it starts and ends each year.' };
    if (raw.start.month === raw.end.month && raw.start.day === raw.end.day && raw.start.time === raw.end.time) return { error: 'The end must differ from the start.' };
    return { kind: 'yearly', start: { month: raw.start.month, day: raw.start.day, time: raw.start.time }, end: { month: raw.end.month, day: raw.end.day, time: raw.end.time } };
  }
  if (raw.kind === 'weekly') {
    if (!Array.isArray(raw.weekdays) || !raw.weekdays.length || raw.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return { error: 'Pick the days of the week.' };
    if (!validTime(raw.start) || !validTime(raw.end) || raw.start === raw.end) return { error: 'Give a start and an end time.' };
    return { kind: 'weekly', weekdays: [...new Set(raw.weekdays as number[])].sort(), start: raw.start, end: raw.end };
  }
  return { error: 'It happens once, every year or every week.' };
}

/** Why "continue progress" can't be offered: Tunarr keeps no episode position for a manual lineup. */
export const CONTINUE_UNSUPPORTED = 'Continuing where the last occurrence stopped isn’t possible: the calendar puts in a manual lineup, and Tunarr keeps no episode progress for one between activations. Start it as it lands, from the beginning, or from a chosen position.';

export function validateCalendarEntry(raw: unknown): CalendarEntryInput | { error: string } {
  if (!isObject(raw)) return { error: 'Send the calendar entry as an object.' };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 120) return { error: 'Give it a name (up to 120 characters).' };
  if (typeof raw.scheduleId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.scheduleId)) return { error: 'Choose a schedule from the library.' };
  if (!Array.isArray(raw.channelIds) || !raw.channelIds.length) return { error: 'Pick at least one channel.' };
  const channelIds = [...new Set(raw.channelIds)];
  if (channelIds.length > MAX_CALENDAR_CHANNELS) return { error: `Up to ${MAX_CALENDAR_CHANNELS} channels per entry.` };
  if (channelIds.some((id) => typeof id !== 'string' || !CHANNEL_ID.test(id))) return { error: 'A channel id is not valid.' };
  const recurrence = validateRecurrence(raw.recurrence);
  if ('error' in recurrence) return recurrence;
  if (!isTimeZone(raw.timeZone)) return { error: 'Choose a time zone (like Europe/Madrid).' };
  const exceptions = Array.isArray(raw.exceptions) ? [...new Set(raw.exceptions)] : [];
  if (exceptions.length > MAX_EXCEPTIONS || exceptions.some((date) => !validDate(date))) return { error: `Exceptions are dates (YYYY-MM-DD), up to ${MAX_EXCEPTIONS}.` };
  const priority = raw.priority ?? 5;
  if (!Number.isInteger(priority) || (priority as number) < 1 || (priority as number) > 9) return { error: 'Priority is a whole number from 1 to 9.' };
  const start = raw.start;
  let startMode: StartMode;
  if (!isObject(start) || start.mode === 'as-is' || start.mode === undefined) startMode = { mode: 'as-is' };
  else if (start.mode === 'restart') startMode = { mode: 'restart' };
  else if (start.mode === 'position' && Number.isInteger(start.position) && (start.position as number) >= 0) startMode = { mode: 'position', position: start.position as number };
  else if (start.mode === 'continue') return { error: CONTINUE_UNSUPPORTED };
  else return { error: 'It starts as it lands, from the beginning, or from a position.' };
  const end = raw.end ?? 'restore';
  if (end !== 'restore' && end !== 'resume' && end !== 'keep') return { error: 'When it ends: restore, resume or keep.' };
  if (recurrence.kind === 'once' && !recurrence.end && end !== 'keep') return { error: 'With no end, there is nothing to restore: choose “keep”, or give an end.' };
  if (recurrence.kind !== 'once' && end === 'keep') return { error: 'A repeating entry has to put the old lineup back each time (restore or resume).' };
  const armLeadMinutes = raw.armLeadMinutes ?? DEFAULT_ARM_LEAD_MINUTES;
  if (!Number.isInteger(armLeadMinutes) || (armLeadMinutes as number) < 15 || (armLeadMinutes as number) > 7 * 24 * 60) return { error: 'Arm it between 15 minutes and 7 days before.' };
  return { name, scheduleId: raw.scheduleId, channelIds: channelIds as string[], recurrence, timeZone: raw.timeZone, exceptions: exceptions as string[], priority: priority as number, start: startMode, end, armLeadMinutes: armLeadMinutes as number, enabled: raw.enabled !== false };
}

/** The lineup an occurrence puts in: the saved one, turned to begin at `position` when asked. */
export function startingLineup<T>(lineup: T[], start: StartMode): T[] {
  if (start.mode !== 'position' || !lineup.length) return lineup;
  const at = Math.min(start.position, lineup.length - 1);
  return [...lineup.slice(at), ...lineup.slice(0, at)];
}

/**
 * The start time that makes the old lineup resume where it was interrupted:
 * it was at `offset` into its cycle when the overlay went in, so it should be
 * there again at `now`.
 */
export function resumedStartTime(previousStart: number, cycleMs: number, interruptedAt: number, now: number) {
  if (!(cycleMs > 0) || !Number.isFinite(previousStart)) return previousStart;
  const offset = (((interruptedAt - previousStart) % cycleMs) + cycleMs) % cycleMs;
  return now - offset;
}

export const occurrenceKey = (channelId: string, start: number) => `${channelId}@${new Date(start).toISOString()}`;
