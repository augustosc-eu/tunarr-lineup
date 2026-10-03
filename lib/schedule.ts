// Slot-schedule editing helpers (Tunarr "time" and "random" schedules).
// Edits only ever re-use sources the channel's schedule already has.
import { slotSourceKey } from '../server/slotSchedule';
import type { LineupItem, Programming } from './lineup';

export { slotSourceKey };

export type Slot = Record<string, unknown> & { type: string; id?: string };

export type SlotSchedule = {
  type: 'time' | 'random';
  slots: Slot[];
  period?: 'day' | 'week';
  padMs?: number;
  latenessMs?: number;
  maxDays?: number;
  flexPreference?: string;
  randomDistribution?: string;
  padStyle?: string;
  timeZoneOffset?: number;
  [key: string]: unknown;
};

export type SchedulePreview = {
  startTime: number;
  lineup: LineupItem[];
  programs: Programming['programs'];
  seed: number[];
  discardCount: number;
};

export type SourceOption = { key: string; label: string; template: Slot };

export const DAY_MS = 86_400_000;
export const ORDER_LABELS: Record<string, string> = {
  next: 'In order',
  shuffle: 'Shuffle',
  ordered_shuffle: 'Ordered shuffle',
  alphanumeric: 'Alphabetical',
  chronological: 'Chronological',
};
const LINK_FIELDS = ['iterationGroup', 'linkMode', 'rerunOverflow'];
const SOURCE_FIELDS = ['showId', 'customShowId', 'fillerListId', 'channelId', 'channelName', 'smartCollectionId', 'show', 'missingShow', 'customShow', 'fillerList', 'channel', 'smartCollection', 'isMissing', 'seasonFilter', 'seasonExcludeFilter'];
const NEEDS_ID = new Set(['movie', 'show', 'custom-show', 'smart-collection', 'filler']);

const named = (value: unknown, field: 'title' | 'name') =>
  value && typeof value === 'object' && typeof (value as Record<string, unknown>)[field] === 'string' ? (value as Record<string, string>)[field] : undefined;

/** Human name for what a slot plays, using the materialized schedule's details. */
export function slotLabel(slot: Slot): string {
  switch (slot.type) {
    case 'show': return named(slot.show, 'title') ?? named(slot.missingShow, 'title') ?? 'Show (unavailable)';
    case 'custom-show': return named(slot.customShow, 'name') ?? 'Custom show';
    case 'filler': return named(slot.fillerList, 'name') ?? 'Filler list';
    case 'redirect': return `→ ${named(slot.channel, 'name') ?? (typeof slot.channelName === 'string' ? slot.channelName : 'Another channel')}`;
    case 'smart-collection': return named(slot.smartCollection, 'name') ?? 'Smart collection';
    case 'movie': return 'Movies';
    case 'flex': return 'Flex (open airtime)';
    default: return slot.type;
  }
}

/** Every source the schedule already uses, plus flex. */
export function sourceOptions(slots: Slot[]): SourceOption[] {
  const options = new Map<string, SourceOption>();
  for (const slot of slots) {
    const key = slotSourceKey(slot);
    if (key && !options.has(key)) options.set(key, { key, label: slotLabel(slot), template: slot });
  }
  if (!options.has('flex')) options.set('flex', { key: 'flex', label: slotLabel({ type: 'flex' }), template: { type: 'flex' } });
  return [...options.values()].sort((a, b) => (a.key === 'flex' ? 1 : b.key === 'flex' ? -1 : a.label.localeCompare(b.label)));
}

/** RFC 4122 v4 id. Uses getRandomValues, which works on plain-HTTP pages. */
export function newSlotId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const withoutLinks = (slot: Slot): Slot => {
  const next = { ...slot };
  for (const field of LINK_FIELDS) delete next[field];
  return next;
};

/** A copy that plays the same source independently (its own id, unlinked). */
export function duplicateSlot(slot: Slot): Slot {
  const copy = withoutLinks(slot);
  if (NEEDS_ID.has(copy.type)) copy.id = newSlotId();
  else delete copy.id;
  return copy;
}

/**
 * Points a slot at a different existing source. Timing fields (start time,
 * weight, cooldown, length) stay; source-specific fields come from a slot that
 * already uses the new source.
 */
export function changeSlotSource(slot: Slot, option: SourceOption): Slot {
  if (slotSourceKey(slot) === option.key) return slot;
  const keep: Slot = { type: option.template.type };
  for (const field of ['startTime', 'padMs', 'overflow', 'latenessMs', 'weight', 'cooldownMs', 'periodMs', 'durationSpec', 'index']) {
    if (field in slot) keep[field] = slot[field];
  }
  const base = withoutLinks(option.template);
  for (const field of ['startTime', 'weight', 'cooldownMs', 'periodMs', 'durationSpec', 'index', 'padMs', 'overflow', 'latenessMs']) delete base[field];
  const next: Slot = { ...base, ...keep };
  if (NEEDS_ID.has(next.type)) next.id = typeof slot.id === 'string' && NEEDS_ID.has(slot.type) ? slot.id : newSlotId();
  else delete next.id;
  if (next.type === 'flex') for (const field of SOURCE_FIELDS) delete next[field];
  return next;
}

export const sortTimeSlots = (slots: Slot[]) => [...slots].sort((a, b) => Number(a.startTime) - Number(b.startTime));

export function periodMs(schedule: Pick<SlotSchedule, 'type' | 'period'>) {
  return schedule.period === 'week' ? 7 * DAY_MS : DAY_MS;
}

/** Shifts every time slot by `deltaMs`, wrapping within the period. */
export function shiftTimeSlots(slots: Slot[], deltaMs: number, period: number) {
  return sortTimeSlots(slots.map((slot) => ({ ...slot, startTime: ((((Number(slot.startTime) + deltaMs) % period) + period) % period) })));
}

export const slotWeightShare = (slots: Slot[], index: number) => {
  const total = slots.reduce((sum, slot) => sum + Math.max(0, Number(slot.weight) || 0), 0);
  return total > 0 ? (Math.max(0, Number(slots[index].weight) || 0) / total) * 100 : 0;
};

/** "HH:MM:SS" for an offset from the start of the day. */
export function offsetToClock(offsetMs: number) {
  const seconds = Math.floor((((offsetMs % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

export function clockToOffset(clock: string) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock);
  if (!match) return NaN;
  const [hours, minutes, seconds = '0'] = match.slice(1);
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return NaN;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Problems that would make Tunarr reject the schedule, per slot. */
export function slotProblems(schedule: Pick<SlotSchedule, 'type' | 'period'>, slots: Slot[]): Array<string | null> {
  const seen = new Map<number, number>();
  return slots.map((slot, index) => {
    if (schedule.type === 'time') {
      const start = Number(slot.startTime);
      if (!Number.isInteger(start) || start < 0 || start >= periodMs(schedule)) return 'Start time is outside the period.';
      if (seen.has(start)) return `Starts at the same time as slot ${seen.get(start)! + 1}.`;
      seen.set(start, index);
      return null;
    }
    if (!(Number(slot.weight) >= 0)) return 'Weight must be 0 or more.';
    if (!(Number(slot.cooldownMs) >= 0)) return 'Cooldown must be 0 or more.';
    const spec = slot.durationSpec as { type?: string; programCount?: number; durationMs?: number } | undefined;
    if (spec?.type === 'dynamic' && !(Number.isInteger(spec.programCount) && spec.programCount! >= 1)) return 'Plays must be at least 1 program.';
    if (spec?.type === 'fixed' && !(Number(spec.durationMs) > 0)) return 'Fixed length must be longer than 0.';
    return null;
  });
}
