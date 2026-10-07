// What each stretch of airtime is, the way a station log shows it: programs,
// commercial breaks, station IDs, promos, flex time. Tunarr only knows lineup
// item types, so spots are recognised by the filler list (and its role) they
// come from.
import { isCommercialBreak } from './broadcast';
import { ROLE_SPOT_LABELS, type FillerRole, type FillerRoles } from './fillerRoles';
import type { Instance, LineupItem } from './lineup';

export type AirKind = 'program' | 'break' | 'flex' | 'station-id' | 'commercial' | 'promo' | 'bumper' | 'filler' | 'redirect';

/** Program id → role of the filler list it belongs to. */
export type SpotIndex = Map<string, FillerRole>;

const ROLE_KIND: Record<FillerRole, AirKind> = { 'station-id': 'station-id', commercials: 'commercial', promos: 'promo', bumpers: 'bumper', other: 'filler' };

export const KIND_BADGES: Record<AirKind, string> = {
  program: '', break: 'BREAK', flex: 'FLEX', 'station-id': 'ID', commercial: 'SPOT', promo: 'PROMO', bumper: 'BUMP', filler: 'FILL', redirect: 'REDIR',
};

export const KIND_LABELS: Record<AirKind, string> = {
  program: 'Programs', break: 'Commercial breaks', flex: 'Flex time', 'station-id': 'Station IDs', commercial: 'Commercials', promo: 'Promos', bumper: 'Bumpers', filler: 'Filler', redirect: 'Redirects',
};

/** Order used by totals, the day strip legend and hour summaries. */
export const KIND_ORDER: AirKind[] = ['program', 'break', 'commercial', 'station-id', 'promo', 'bumper', 'filler', 'flex', 'redirect'];

export function airKind(item: LineupItem, spots: SpotIndex, roles: FillerRoles = {}): AirKind {
  if (item.type === 'flex') return isCommercialBreak(item) ? 'break' : 'flex';
  if (item.type === 'redirect') return 'redirect';
  const role = (item.id && spots.get(item.id)) || (typeof item.fillerListId === 'string' ? roles[item.fillerListId] : undefined);
  if (role) return ROLE_KIND[role];
  return item.type === 'filler' ? 'filler' : 'program';
}

/** Commercial time in the log sense: breaks and every spot, but not programs or plain flex. */
export const isInterstitial = (kind: AirKind) => kind !== 'program' && kind !== 'redirect';

export type HourSummary = { start: number; byKind: Partial<Record<AirKind, number>> };

/** Airtime per kind for each clock hour that has rows, clipped to [from, to). */
export function hourSummaries(rows: Instance[], kindOf: (row: Instance) => AirKind, from: number, to: number): Map<number, HourSummary> {
  const hours = new Map<number, HourSummary>();
  for (const row of rows) {
    const kind = kindOf(row);
    let cursor = Math.max(row.start, from);
    const end = Math.min(row.stop, to);
    while (cursor < end) {
      const hour = new Date(cursor);
      hour.setMinutes(0, 0, 0);
      const next = new Date(hour);
      next.setHours(next.getHours() + 1);
      const slice = Math.min(end, next.getTime()) - cursor;
      const summary = hours.get(hour.getTime()) ?? { start: hour.getTime(), byKind: {} };
      summary.byKind[kind] = (summary.byKind[kind] ?? 0) + slice;
      hours.set(hour.getTime(), summary);
      cursor += slice;
    }
  }
  return hours;
}

export type StripSegment = { kind: AirKind; start: number; stop: number; position: number };

/** Consecutive rows of the same kind merged, for the day strip. `position` is the first row's. */
export function stripSegments(rows: Instance[], kindOf: (row: Instance) => AirKind, from: number, to: number): StripSegment[] {
  const segments: StripSegment[] = [];
  rows.forEach((row, position) => {
    const start = Math.max(row.start, from);
    const stop = Math.min(row.stop, to);
    if (stop <= start) return;
    const kind = kindOf(row);
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.stop === start) last.stop = stop;
    else segments.push({ kind, start, stop, position });
  });
  return segments;
}

export type Spot = { id: string; title: string; duration: number };
export type ListSpots = { name: string; role?: FillerRole; spots: Spot[] };
export type RundownLine = { kind: AirKind; title: string; detail: string; duration: number };

const seeded = (seed: number) => {
  let state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (state = (state * 16807) % 2147483647);
};

/**
 * A plausible rundown of a commercial break. Tunarr picks the spots itself at
 * air time, so this is an estimate: a station ID first (if one of the break's
 * lists holds IDs and none aired just before), then spots taken in turn from
 * the other lists while they fit, and whatever is left as flex.
 */
export function estimateBreakFill(item: LineupItem, duration: number, lists: Record<string, ListSpots>, seed: number, idAiredBefore = false): RundownLine[] {
  const ids = ((item.fillerConfig as { fillerListIds?: unknown } | undefined)?.fillerListIds ?? []) as string[];
  const known = ids.map((id) => lists[id]).filter((list): list is ListSpots => !!list && list.spots.length > 0);
  const next = seeded(seed);
  const lines: RundownLine[] = [];
  let left = duration;
  const take = (list: ListSpots, kind: AirKind) => {
    const fitting = list.spots.filter((spot) => spot.duration > 0 && spot.duration <= left);
    if (!fitting.length) return false;
    const spot = fitting[next() % fitting.length];
    lines.push({ kind, title: spot.title, detail: list.name, duration: spot.duration });
    left -= spot.duration;
    return true;
  };
  const idList = known.find((list) => list.role === 'station-id');
  if (idList && !idAiredBefore) take(idList, 'station-id');
  const rest = known.filter((list) => list !== idList || known.length === 1);
  let stalled = 0;
  for (let turn = 0; rest.length && stalled < rest.length && lines.length < 60; turn += 1) {
    const list = rest[turn % rest.length];
    if (take(list, list.role ? ROLE_KIND[list.role] : 'commercial')) stalled = 0;
    else stalled += 1;
  }
  if (left >= 1000) lines.push({ kind: 'flex', title: 'Flex time', detail: 'No spot fits; Tunarr plays filler or the offline screen', duration: left });
  return lines;
}

export const spotLabel = (role: FillerRole | undefined) => (role ? ROLE_SPOT_LABELS[role] : 'Filler');
