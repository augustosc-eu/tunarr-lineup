// The desk's side of the schedule library and the calendar (server/calendar.ts,
// D66): labels, the time zones offered, and the flat form the dialog edits,
// turned into the entry the companion validates. Pure.
import type { CalendarConflict, CalendarEntryInput, EndBehavior, Occurrence, Recurrence } from '../server/calendar';

export type { CalendarConflict, CalendarEntryInput, EndBehavior, Occurrence, Recurrence };
export { CONTINUE_UNSUPPORTED } from '../server/calendar';

export const COMMON_ZONES = ['UTC', 'Europe/London', 'Europe/Madrid', 'Europe/Rome', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Argentina/Buenos_Aires', 'America/Sao_Paulo', 'Asia/Tokyo', 'Australia/Sydney'];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const START_LABELS = { 'as-is': 'As it lands (where the cycle falls, like Save Later)', restart: 'From the beginning at the start time', position: 'From a chosen position at the start time' } as const;
export const END_LABELS: Record<EndBehavior, string> = {
  restore: 'Restore exactly: the old lineup and start time, as if it had kept airing',
  resume: 'Resume: the old lineup picks up where it was interrupted',
  keep: 'Keep it: nothing changes at the end',
};

/** The browser's own time zone, or UTC. */
export function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const zoneChoices = (current: string) => [...new Set([browserZone(), current, ...COMMON_ZONES].filter(Boolean))];

/** An instant as read in the entry's own zone. */
export function inZone(ms: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

const monthDay = (month: number, day: number) => `${day} ${MONTH_NAMES[month - 1]}`;

export function recurrenceLabel(recurrence: Recurrence) {
  switch (recurrence.kind) {
    case 'once': return recurrence.end ? `Once, ${recurrence.start.date} ${recurrence.start.time} → ${recurrence.end.date} ${recurrence.end.time}` : `From ${recurrence.start.date} ${recurrence.start.time}, kept`;
    case 'yearly': return `Every year, ${monthDay(recurrence.start.month, recurrence.start.day)} ${recurrence.start.time} → ${monthDay(recurrence.end.month, recurrence.end.day)} ${recurrence.end.time}`;
    case 'weekly': return `Every ${recurrence.weekdays.map((day) => WEEKDAY_NAMES[day].slice(0, 3)).join(', ')}, ${recurrence.start}–${recurrence.end}`;
  }
}

export function conflictLine(conflict: CalendarConflict, channelName: string, timeZone: string) {
  const span = `${inZone(conflict.start, timeZone)}${conflict.end ? ` → ${inZone(conflict.end, timeZone)}` : ', with no end'}`;
  switch (conflict.resolution) {
    case 'refused': return `${channelName}: overlaps “${conflict.otherName}” (same priority) ${span}. Change one before saving.`;
    case 'this-wins': return `${channelName}: overlaps “${conflict.otherName}” ${span}; this one has the higher priority, so that one is skipped there.`;
    case 'other-wins': return `${channelName}: overlaps “${conflict.otherName}” ${span}; it has the higher priority, so this one is skipped there.`;
  }
}

/** The flat form the dialog edits. Positions are shown from 1. */
export type CalendarForm = {
  name: string;
  scheduleId: string;
  channelIds: string[];
  kind: Recurrence['kind'];
  onceStartDate: string; onceStartTime: string; onceEndDate: string; onceEndTime: string; onceKeep: boolean;
  yearStartMonth: number; yearStartDay: number; yearStartTime: string; yearEndMonth: number; yearEndDay: number; yearEndTime: string;
  weekdays: number[]; weekStart: string; weekEnd: string;
  timeZone: string;
  exceptions: string[];
  priority: number;
  startMode: 'as-is' | 'restart' | 'position';
  position: number;
  end: EndBehavior;
  armLeadHours: number;
  enabled: boolean;
};

const ymd = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function blankForm(scheduleId: string, channelIds: string[], now = new Date()): CalendarForm {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    name: '', scheduleId, channelIds, kind: 'yearly',
    onceStartDate: ymd(tomorrow), onceStartTime: '20:00', onceEndDate: ymd(new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1)), onceEndTime: '06:00', onceKeep: false,
    yearStartMonth: 10, yearStartDay: 31, yearStartTime: '18:00', yearEndMonth: 11, yearEndDay: 1, yearEndTime: '06:00',
    weekdays: [6], weekStart: '08:00', weekEnd: '12:00',
    timeZone: browserZone(), exceptions: [], priority: 5, startMode: 'restart', position: 1, end: 'restore', armLeadHours: 6, enabled: true,
  };
}

export function formToInput(form: CalendarForm): CalendarEntryInput {
  const recurrence: Recurrence = form.kind === 'once'
    ? { kind: 'once', start: { date: form.onceStartDate, time: form.onceStartTime }, end: form.onceKeep ? null : { date: form.onceEndDate, time: form.onceEndTime } }
    : form.kind === 'yearly'
      ? { kind: 'yearly', start: { month: form.yearStartMonth, day: form.yearStartDay, time: form.yearStartTime }, end: { month: form.yearEndMonth, day: form.yearEndDay, time: form.yearEndTime } }
      : { kind: 'weekly', weekdays: [...form.weekdays].sort(), start: form.weekStart, end: form.weekEnd };
  return {
    name: form.name.trim(), scheduleId: form.scheduleId, channelIds: form.channelIds, recurrence, timeZone: form.timeZone, exceptions: form.exceptions, priority: form.priority,
    start: form.startMode === 'position' ? { mode: 'position', position: Math.max(0, form.position - 1) } : { mode: form.startMode },
    end: form.end, armLeadMinutes: Math.round(form.armLeadHours * 60), enabled: form.enabled,
  };
}

export function inputToForm(entry: CalendarEntryInput): CalendarForm {
  const form = blankForm(entry.scheduleId, entry.channelIds);
  const recurrence = entry.recurrence;
  if (recurrence.kind === 'once') Object.assign(form, { onceStartDate: recurrence.start.date, onceStartTime: recurrence.start.time, onceKeep: !recurrence.end, ...(recurrence.end ? { onceEndDate: recurrence.end.date, onceEndTime: recurrence.end.time } : {}) });
  if (recurrence.kind === 'yearly') Object.assign(form, { yearStartMonth: recurrence.start.month, yearStartDay: recurrence.start.day, yearStartTime: recurrence.start.time, yearEndMonth: recurrence.end.month, yearEndDay: recurrence.end.day, yearEndTime: recurrence.end.time });
  if (recurrence.kind === 'weekly') Object.assign(form, { weekdays: recurrence.weekdays, weekStart: recurrence.start, weekEnd: recurrence.end });
  return {
    ...form, name: entry.name, kind: recurrence.kind, timeZone: entry.timeZone, exceptions: entry.exceptions, priority: entry.priority,
    startMode: entry.start.mode, position: entry.start.mode === 'position' ? entry.start.position + 1 : 1, end: entry.end, armLeadHours: entry.armLeadMinutes / 60, enabled: entry.enabled,
  };
}
