// Broadcast-scheduling helpers: timecode, block moves, time targeting,
// day totals and program-log export. Pure functions; no React.
import { cycleDuration, type Instance, type LineupItem } from './lineup';

const pad = (value: number) => String(value).padStart(2, '0');

/** Wall-clock time of day as HH:MM:SS in the viewer's time zone. */
export function clockTimecode(ms: number) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Length as H:MM:SS (or Nd HH:MM:SS for cycles longer than a day). */
export function durationTimecode(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${days ? pad(hours) : hours}:${pad(minutes)}:${pad(seconds)}`;
  return days ? `${days}d ${clock}` : clock;
}

export type Block = { start: number; end: number };

export const normalizeBlock = (anchor: number, focus: number): Block => ({ start: Math.min(anchor, focus), end: Math.max(anchor, focus) });

const validBlock = (lineup: LineupItem[], block: Block) => block.start >= 0 && block.end < lineup.length && block.start <= block.end;

/**
 * Moves a contiguous block of lineup items so it sits before `target`
 * (an index in the original lineup, or lineup.length for the end).
 * Returns the new lineup and the block's new position. Items are never
 * added, dropped or copied.
 */
export function moveBlock(lineup: LineupItem[], block: Block, target: number): { lineup: LineupItem[]; block: Block } | null {
  if (!validBlock(lineup, block) || target < 0 || target > lineup.length) return null;
  if (target >= block.start && target <= block.end + 1) return null;
  const items = lineup.slice(block.start, block.end + 1);
  const rest = [...lineup.slice(0, block.start), ...lineup.slice(block.end + 1)];
  const insertAt = target > block.end ? target - items.length : target;
  const next = [...rest.slice(0, insertAt), ...items, ...rest.slice(insertAt)];
  return { lineup: next, block: { start: insertAt, end: insertAt + items.length - 1 } };
}

/** Slides a block one item earlier (-1) or later (+1) past its neighbour. */
export function shiftBlock(lineup: LineupItem[], block: Block, direction: -1 | 1) {
  if (!validBlock(lineup, block)) return null;
  return direction < 0
    ? block.start > 0 ? moveBlock(lineup, block, block.start - 1) : null
    : block.end < lineup.length - 1 ? moveBlock(lineup, block, block.end + 2) : null;
}

/** Moves a block so its first item lands at 1-based `position` in the resulting lineup. */
export function moveBlockToPosition(lineup: LineupItem[], block: Block, position: number) {
  if (!validBlock(lineup, block) || !Number.isInteger(position)) return null;
  const size = block.end - block.start + 1;
  const insertAt = Math.min(Math.max(position - 1, 0), lineup.length - size);
  if (insertAt === block.start) return null;
  const items = lineup.slice(block.start, block.end + 1);
  const rest = [...lineup.slice(0, block.start), ...lineup.slice(block.end + 1)];
  return { lineup: [...rest.slice(0, insertAt), ...items, ...rest.slice(insertAt)], block: { start: insertAt, end: insertAt + size - 1 } };
}

/** Start time of the given lineup position in the cycle occurrence nearest to `near`. */
export function occurrenceStart(lineup: LineupItem[], startTime: number, index: number, near: number) {
  const cycle = cycleDuration(lineup);
  if (cycle <= 0 || index < 0 || index >= lineup.length) return NaN;
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += Math.max(0, lineup[i].duration || 0);
  const first = startTime + offset;
  const cycles = Math.round((near - first) / cycle);
  return first + cycles * cycle;
}

/**
 * Places a block so its first item starts as close as possible to `time`.
 * Every insertion point is tried against the real cycle (which keeps the
 * same total length), so the reported start is where the block will air.
 */
export function moveBlockToTime(lineup: LineupItem[], block: Block, startTime: number, time: number) {
  if (!validBlock(lineup, block)) return null;
  const cycle = cycleDuration(lineup);
  if (cycle <= 0) return null;
  const blockItems = lineup.slice(block.start, block.end + 1);
  const rest = [...lineup.slice(0, block.start), ...lineup.slice(block.end + 1)];
  let best = { insertAt: 0, start: NaN, distance: Infinity };
  let offset = 0;
  for (let insertAt = 0; insertAt <= rest.length; insertAt += 1) {
    const first = startTime + offset;
    const start = first + Math.round((time - first) / cycle) * cycle;
    const distance = Math.abs(start - time);
    if (distance < best.distance) best = { insertAt, start, distance };
    if (insertAt < rest.length) offset += Math.max(0, rest[insertAt].duration || 0);
  }
  if (best.insertAt === block.start) return { lineup, block, start: best.start, unchanged: true };
  const next = [...rest.slice(0, best.insertAt), ...blockItems, ...rest.slice(best.insertAt)];
  return { lineup: next, block: { start: best.insertAt, end: best.insertAt + blockItems.length - 1 }, start: best.start, unchanged: false };
}

/** Lineup positions whose item differs from the saved lineup. */
export function changedPositions(current: LineupItem[], original: LineupItem[]) {
  const changed = new Set<number>();
  const keys = new WeakMap<object, string>();
  const key = (item: LineupItem) => {
    let value = keys.get(item);
    if (value === undefined) {
      value = JSON.stringify(item);
      keys.set(item, value);
    }
    return value;
  };
  current.forEach((item, index) => {
    const before = original[index];
    if (!before || key(item) !== key(before)) changed.add(index);
  });
  return changed;
}

export type DayTotals = { programs: number; total: number; byType: Record<string, number> };

/** Airtime per lineup item type within [from, to). */
export function dayTotals(rows: Instance[], from: number, to: number): DayTotals {
  const byType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const length = Math.max(0, Math.min(row.stop, to) - Math.max(row.start, from));
    byType[row.item.type] = (byType[row.item.type] ?? 0) + length;
    total += length;
  }
  return { programs: rows.length, total, byType };
}

/** The row on air at `now`, or -1. */
export function onAirPosition(rows: Instance[], now: number) {
  return rows.findIndex((row) => row.start <= now && now < row.stop);
}

const csvCell = (value: string | number) => {
  const text = String(value);
  // Guard against spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function toCsv(header: string[], rows: Array<Array<string | number>>) {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Inserts new entries at `at` (0..length). Returns them selected. */
export function insertItems(lineup: LineupItem[], at: number, items: LineupItem[]) {
  if (!items.length || at < 0 || at > lineup.length) return null;
  return { lineup: [...lineup.slice(0, at), ...items, ...lineup.slice(at)], block: { start: at, end: at + items.length - 1 } };
}

/** Removes a block. Selection moves to the entry that took its place. */
export function removeBlock(lineup: LineupItem[], block: Block) {
  if (!validBlock(lineup, block)) return null;
  const next = [...lineup.slice(0, block.start), ...lineup.slice(block.end + 1)];
  const index = Math.min(block.start, Math.max(next.length - 1, 0));
  return { lineup: next, block: { start: index, end: index } };
}

/** Flex, commercial breaks and redirects have an adjustable length. */
export const hasAdjustableLength = (item: LineupItem | undefined) => item?.type === 'flex' || item?.type === 'redirect';

export function setItemDuration(lineup: LineupItem[], index: number, duration: number) {
  const item = lineup[index];
  if (!hasAdjustableLength(item) || !(duration > 0) || item.duration === duration) return null;
  const next = [...lineup];
  next[index] = { ...item, duration: Math.round(duration) };
  return next;
}

export function makeFlex(duration: number): LineupItem {
  return { type: 'flex', duration: Math.round(duration) };
}

/**
 * A commercial break: flex time that Tunarr fills from the chosen filler lists
 * (with a repeat cooldown), as Tunarr's own "offline filler" for flex works.
 */
export function makeCommercialBreak(duration: number, fillerListIds: string[], repeatCooldownMs = 0): LineupItem {
  return { type: 'flex', duration: Math.round(duration), fillerConfig: { fillerListIds, fillerRepeatCooldownMs: repeatCooldownMs, origin: 'flex' } };
}

export const isCommercialBreak = (item: LineupItem | undefined) =>
  item?.type === 'flex' && Array.isArray((item.fillerConfig as { fillerListIds?: unknown } | undefined)?.fillerListIds) && ((item.fillerConfig as { fillerListIds: unknown[] }).fillerListIds.length > 0);

export function makeRedirect(channel: { id: string; number: number; name: string }, duration: number): LineupItem {
  return { type: 'redirect', channel: channel.id, channelNumber: channel.number, channelName: channel.name, duration: Math.round(duration) };
}

/**
 * The station ID to air next: the one used least in the lineup so far, so IDs
 * rotate the way a station's continuity does. Ties go to list order.
 */
export function pickStationId<T extends { id: string }>(ids: T[], lineup: LineupItem[], extraUses: Map<string, number> = new Map()): T | undefined {
  if (!ids.length) return undefined;
  const uses = new Map<string, number>();
  for (const item of lineup) if (item.id) uses.set(item.id, (uses.get(item.id) ?? 0) + 1);
  let best = ids[0];
  let bestUses = Infinity;
  for (const id of ids) {
    const count = (uses.get(id.id) ?? 0) + (extraUses.get(id.id) ?? 0);
    if (count < bestUses) {
      best = id;
      bestUses = count;
    }
  }
  return best;
}

/**
 * A commercial break that opens with a station ID: the ID as a real program
 * (Tunarr's flex picks filler at random, so it can't promise what plays first),
 * then flex time filled from the lists. The ID's length comes out of the break,
 * so the break still ends when it was meant to.
 */
export function makeBreakWithId(duration: number, fillerListIds: string[], id: { id: string; duration: number }, repeatCooldownMs = 0): LineupItem[] {
  const rest = Math.round(duration - id.duration);
  const opener: LineupItem = { type: 'content', id: id.id, duration: id.duration };
  return rest >= 1000 ? [opener, makeCommercialBreak(rest, fillerListIds, repeatCooldownMs)] : [opener];
}

/**
 * Puts a rotating station ID in front of every commercial break that doesn't
 * already open with one. Breaks are shortened by the ID's length when they
 * have room, so programs keep their air times.
 */
export function openBreaksWithIds(lineup: LineupItem[], ids: Array<{ id: string; duration: number }>, isId: (item: LineupItem) => boolean) {
  const next: LineupItem[] = [];
  const used = new Map<string, number>();
  let added = 0;
  lineup.forEach((item, index) => {
    if (isCommercialBreak(item) && !(index > 0 && isId(lineup[index - 1]))) {
      const id = pickStationId(ids, lineup, used);
      if (id) {
        next.push({ type: 'content', id: id.id, duration: id.duration });
        used.set(id.id, (used.get(id.id) ?? 0) + 1);
        added += 1;
        next.push(item.duration - id.duration >= 1000 ? { ...item, duration: Math.round(item.duration - id.duration) } : item);
        return;
      }
    }
    next.push(item);
  });
  return added ? { lineup: next, added } : null;
}
