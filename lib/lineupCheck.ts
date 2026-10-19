// The lineup check: problems a broadcaster would catch before air. Some are
// about the lineup itself (a program Tunarr no longer has, a redirect to a
// channel that's gone), some about what airs in the days checked (the same
// episode twice in a day, an hour over its commercial limit). Pure: the dialog
// passes the rows it projected and how each row's kind is decided.
import { isInterstitial, type AirKind } from './airKinds';
import { clockTimecode, durationTimecode, isCommercialBreak } from './broadcast';
import type { Instance, LineupItem, Programming } from './lineup';
import { getProgram, programDetail, programTitle } from './programInfo';

export type Severity = 'error' | 'warning' | 'info';

export type Issue = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** When it airs (the first time, in the range checked), to jump there. */
  at?: number;
  /** The lineup position it concerns, to select it. */
  lineupIndex?: number;
};

export type CheckSettings = {
  /** Commercial minutes allowed in a clock hour; null turns the check off. */
  maxCommercialMinutes: number | null;
  /** Hours (0–24, local time) when mature-rated programs are flagged; null turns it off. */
  familyHours: { from: number; to: number } | null;
  /** Content ratings counted as mature. */
  matureRatings: string[];
};

export const DEFAULT_MATURE_RATINGS = ['TV-MA', 'R', 'NC-17', 'X', '18', '18+', 'R18+', 'MA15+', 'NR-18'];
export const DEFAULT_CHECK_SETTINGS: CheckSettings = { maxCommercialMinutes: 18, familyHours: null, matureRatings: DEFAULT_MATURE_RATINGS };

export type CheckInput = {
  lineup: LineupItem[];
  programs: Programming['programs'];
  /** Rows airing in the range checked (one day, or several), in time order. */
  rows: Instance[];
  kindOf: (row: Instance) => AirKind;
  channelId: string;
  channels: Array<{ id: string; number: number; name: string }>;
  /** The channel's own filler lists (what Tunarr plays in flex time); null when not known. */
  channelFillerListIds: string[] | null;
  /** Filler lists that exist in Tunarr; null when not known. */
  knownFillerListIds: Set<string> | null;
  /** Every redirect between channels, when they were loaded (for loops). */
  redirectEdges?: Array<{ from: string; to: string }>;
  settings: CheckSettings;
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const dayLabel = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
const localDay = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const listTimes = (times: number[]) => times.slice(0, 4).map((time) => clockTimecode(time).slice(0, 5)).join(', ') + (times.length > 4 ? ` and ${times.length - 4} more` : '');

/** The channels a redirect loop through `channelId` visits (ending back at it), or null. */
export function redirectLoop(channelId: string, edges: Array<{ from: string; to: string }>): string[] | null {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    for (const to of next.get(at) ?? []) {
      if (to === channelId) return [...path, to];
      if (seen.has(to)) continue;
      seen.add(to);
      const found = walk(to, [...path, to]);
      if (found) return found;
    }
    return null;
  };
  return walk(channelId, [channelId]);
}

/** Every problem found, errors first, then by when they air. */
export function checkLineup(input: CheckInput): Issue[] {
  const { lineup, programs, rows, kindOf, channelId, channels, settings } = input;
  const issues: Issue[] = [];
  const firstAir = new Map<number, number>();
  for (const row of rows) if (row.lineupIndex >= 0 && !firstAir.has(row.lineupIndex)) firstAir.set(row.lineupIndex, row.start);
  const channelName = (id: string) => { const channel = channels.find((item) => item.id === id); return channel ? `CH ${channel.number} ${channel.name}` : 'a channel that no longer exists'; };
  const add = (issue: Omit<Issue, 'at'> & { at?: number }) => issues.push({ ...issue, at: issue.at ?? (issue.lineupIndex !== undefined ? firstAir.get(issue.lineupIndex) : undefined) });

  // ---- The lineup itself.
  const missing = lineup.flatMap((item, index) => (item.type === 'content' && item.id && !getProgram(item, programs) ? [index] : []));
  if (missing.length) add({ id: 'missing-program', severity: 'error', lineupIndex: missing[0], title: `${plural(missing.length, 'program')} Tunarr no longer has`, detail: `Lineup position${missing.length === 1 ? '' : 's'} ${missing.slice(0, 6).map((index) => `#${index + 1}`).join(', ')}${missing.length > 6 ? '…' : ''}. The file may have left the library; Tunarr skips it or shows the offline screen.` });

  const zero = lineup.flatMap((item, index) => (!(item.duration > 0) ? [index] : []));
  if (zero.length) add({ id: 'zero-length', severity: 'warning', lineupIndex: zero[0], title: `${plural(zero.length, 'item')} with no length`, detail: 'Tunarr won’t accept them, so saving leaves them out.' });

  lineup.forEach((item, index) => {
    if (item.type !== 'redirect') return;
    const target = String(item.channel ?? '');
    if (target === channelId) add({ id: `redirect-self-${index}`, severity: 'error', lineupIndex: index, title: 'A redirect to this same channel', detail: `#${index + 1} sends viewers back to this channel, which Tunarr can’t play.` });
    else if (!channels.some((channel) => channel.id === target)) add({ id: `redirect-missing-${index}`, severity: 'error', lineupIndex: index, title: `A redirect to ${String(item.channelName ?? 'a channel')} that no longer exists`, detail: `#${index + 1}: Tunarr turns it into off-air time.` });
  });
  if (input.redirectEdges) {
    const own = lineup.filter((item) => item.type === 'redirect').map((item) => ({ from: channelId, to: String(item.channel ?? '') }));
    const loop = redirectLoop(channelId, [...input.redirectEdges.filter((edge) => edge.from !== channelId), ...own]);
    if (loop) {
      const index = lineup.findIndex((item) => item.type === 'redirect' && item.channel === loop[1]);
      add({ id: 'redirect-loop', severity: 'error', lineupIndex: index >= 0 ? index : undefined, title: 'Redirects go round in a loop', detail: `${loop.map(channelName).join(' → ')}. A viewer sent round this loop never reaches a program.` });
    }
  }

  if (input.knownFillerListIds) {
    const gone = lineup.flatMap((item, index) => {
      const ids = isCommercialBreak(item) ? ((item.fillerConfig as { fillerListIds: string[] }).fillerListIds ?? []) : [];
      return ids.some((id) => !input.knownFillerListIds!.has(id)) ? [index] : [];
    });
    if (gone.length) add({ id: 'break-missing-list', severity: 'error', lineupIndex: gone[0], title: `${plural(gone.length, 'commercial break')} filled from a deleted filler list`, detail: 'Edit the break or insert a new one with lists that exist.' });
  }

  const plainFlex = lineup.flatMap((item, index) => (item.type === 'flex' && !isCommercialBreak(item) ? [index] : []));
  if (plainFlex.length && input.channelFillerListIds && !input.channelFillerListIds.length) {
    const total = plainFlex.reduce((sum, index) => sum + Math.max(0, lineup[index].duration), 0);
    add({ id: 'flex-offline', severity: 'warning', lineupIndex: plainFlex[0], title: `${durationTimecode(total)} of flex time shows the offline screen`, detail: 'This channel has no filler lists, so Tunarr has nothing to play in flex time. Add lists in Channel Settings → Commercials, or turn the flex into commercial breaks.' });
  }
  lineup.forEach((item, index) => {
    if (item.type === 'flex' && !isCommercialBreak(item) && item.duration >= 30 * 60_000) {
      add({ id: `long-flex-${index}`, severity: 'info', lineupIndex: index, title: `${durationTimecode(item.duration)} of flex time in one stretch`, detail: `#${index + 1}. Long flex reads as dead air; a program or a break may fit better.` });
    }
  });

  // ---- What airs in the range.
  const programRows = rows.filter((row) => row.lineupIndex >= 0 && kindOf(row) === 'program' && row.item.type === 'content' && row.item.id);
  const byDay = new Map<string, Map<string, Instance[]>>();
  for (const row of programRows) {
    const day = byDay.get(localDay(row.start)) ?? new Map<string, Instance[]>();
    const list = day.get(row.item.id!) ?? [];
    list.push(row);
    day.set(row.item.id!, list);
    byDay.set(localDay(row.start), day);
  }
  for (const day of byDay.values()) {
    for (const [id, airings] of day) {
      if (airings.length < 2) continue;
      const first = airings[0];
      const name = `“${programTitle(first.item, programs)}${programDetail(first.item, programs) ? ` · ${programDetail(first.item, programs)}` : ''}”`;
      add({ id: `repeat-${id}-${first.start}`, severity: 'warning', lineupIndex: first.lineupIndex, at: first.start, title: `${name} airs ${airings.length} times on ${dayLabel(first.start)}`, detail: `At ${listTimes(airings.map((row) => row.start))}.` });
    }
  }
  // The same program twice in a row (breaks and IDs between don't count as a change).
  let last: Instance | undefined;
  for (const row of rows) {
    if (row.lineupIndex < 0) continue;
    const kind = kindOf(row);
    if (isInterstitial(kind) && kind !== 'flex') continue;
    if (kind === 'program' && last && last.item.id && row.item.id === last.item.id && row.item.type === 'content' && row.start !== last.start) {
      add({ id: `twice-${row.start}`, severity: 'warning', lineupIndex: row.lineupIndex, at: row.start, title: `“${programTitle(row.item, programs)}” twice in a row`, detail: `The same program airs at ${clockTimecode(last.start).slice(0, 5)} and again at ${clockTimecode(row.start).slice(0, 5)} on ${dayLabel(row.start)}.` });
    }
    last = row;
  }

  if (settings.maxCommercialMinutes !== null) {
    const limit = settings.maxCommercialMinutes * 60_000;
    const hours = new Map<number, number>();
    for (const row of rows) {
      const kind = kindOf(row);
      if (!['break', 'commercial', 'promo', 'bumper', 'filler'].includes(kind)) continue;
      let cursor = row.start;
      while (cursor < row.stop) {
        const hour = new Date(cursor).setMinutes(0, 0, 0);
        const next = new Date(hour).setHours(new Date(hour).getHours() + 1);
        const slice = Math.min(row.stop, next) - cursor;
        hours.set(hour, (hours.get(hour) ?? 0) + slice);
        cursor += slice;
      }
    }
    for (const [hour, total] of [...hours].sort((a, b) => a[0] - b[0])) {
      if (total <= limit + 1000) continue;
      add({ id: `ads-${hour}`, severity: 'warning', at: hour, title: `${Math.round(total / 60_000)} minutes of commercials in the ${clockTimecode(hour).slice(0, 5)} hour`, detail: `${dayLabel(hour)}. Your limit is ${settings.maxCommercialMinutes} minutes an hour.` });
    }
  }

  if (settings.familyHours) {
    const { from, to } = settings.familyHours;
    const mature = new Set(settings.matureRatings.map((rating) => rating.trim().toUpperCase()).filter(Boolean));
    const flagged = new Set<string>();
    for (const row of programRows) {
      const rating = String(getProgram(row.item, programs)?.rating ?? '').trim().toUpperCase();
      if (!rating || !mature.has(rating)) continue;
      const hour = new Date(row.start).getHours();
      const inside = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
      if (!inside || flagged.has(`${row.item.id}-${localDay(row.start)}`)) continue;
      flagged.add(`${row.item.id}-${localDay(row.start)}`);
      add({ id: `mature-${row.start}`, severity: 'warning', lineupIndex: row.lineupIndex, at: row.start, title: `“${programTitle(row.item, programs)}” (${rating}) in family hours`, detail: `${dayLabel(row.start)} at ${clockTimecode(row.start).slice(0, 5)}, inside ${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00.` });
    }
  }

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** One line per issue, for the AI review. */
export const issueLines = (issues: Issue[]) => issues.map((issue) => `${issue.severity.toUpperCase()}: ${issue.title}. ${issue.detail}`);
