// Several days at once: the week view, multi-day program-log exports and the
// summary the AI review reads. Days are projected from the lineup (Tunarr's
// guide only covers about a day), so they show the lineup's plan.
import { isInterstitial, type AirKind } from './airKinds';
import { clockTimecode, durationTimecode } from './broadcast';
import { instancesForDay, type Instance, type LineupItem, type Programming } from './lineup';
import { programDetail, programTitle } from './programInfo';

export type DayRows = { date: string; rows: Instance[] };

const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** `count` local dates from `from` (yyyy-mm-dd). */
export function dateRange(from: string, count: number) {
  const dates: string[] = [];
  const date = new Date(`${from}T12:00:00`);
  for (let index = 0; index < count; index += 1) {
    dates.push(inputDate(date));
    date.setDate(date.getDate() + 1);
  }
  return dates;
}

/** The Monday on or before `date`. */
export function weekStart(date: string) {
  const day = new Date(`${date}T12:00:00`);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return inputDate(day);
}

export function projectDays(lineup: LineupItem[], startTime: number, dates: string[]): DayRows[] {
  return dates.map((date) => ({ date, rows: instancesForDay(lineup, startTime, date) }));
}

export type Block = { start: number; stop: number; title: string; detail: string; kind: AirKind; count: number; lineupIndex: number };

/**
 * A day as blocks, the way a TV listings page shows it: programs of the same
 * show merged ("Bravo, 3 episodes"), with the breaks, IDs and spots between
 * them folded in. Flex longer than 15 minutes and redirects stay visible.
 */
export function dayBlocks(rows: Instance[], programs: Programming['programs'], kindOf: (row: Instance) => AirKind, from: number, to: number): Block[] {
  const blocks: Block[] = [];
  for (const row of rows) {
    const start = Math.max(row.start, from);
    const stop = Math.min(row.stop, to);
    if (stop <= start) continue;
    const kind = kindOf(row);
    const last = blocks[blocks.length - 1];
    if (isInterstitial(kind) && !(kind === 'flex' && stop - start > 15 * 60_000)) {
      if (last) last.stop = stop;
      else blocks.push({ start, stop, title: kind === 'flex' ? 'Flex time' : 'Commercials', detail: '', kind, count: 0, lineupIndex: row.lineupIndex });
      continue;
    }
    const title = row.title ?? programTitle(row.item, programs);
    if (last && last.kind === kind && last.title === title && kind === 'program') {
      last.stop = stop;
      last.count += 1;
      continue;
    }
    blocks.push({ start, stop, title, detail: programDetail(row.item, programs), kind, count: 1, lineupIndex: row.lineupIndex });
  }
  return blocks;
}

/** CSV rows (Date, Start, End, Duration, Type, Title, Detail, Lineup position) for several days. */
export function logRows(days: DayRows[], programs: Programming['programs'], kindOf: (row: Instance) => AirKind, kindLabel: (kind: AirKind) => string) {
  return days.flatMap(({ date, rows }) => rows.map((row) => [
    date,
    clockTimecode(row.start),
    clockTimecode(row.stop),
    durationTimecode(row.stop - row.start),
    kindLabel(kindOf(row)),
    row.title ?? programTitle(row.item, programs),
    row.lineupIndex < 0 ? 'In Tunarr’s guide only' : programDetail(row.item, programs),
    row.lineupIndex < 0 ? '' : row.lineupIndex + 1,
  ]));
}

/**
 * The week in a few lines per day, for the AI review: each block's time and
 * title, and the hours with the most commercial time. Bounded so a long
 * lineup still fits a prompt.
 */
export function weekSummary(days: DayRows[], programs: Programming['programs'], kindOf: (row: Instance) => AirKind, maxChars = 30_000) {
  const lines: string[] = [];
  for (const { date, rows } of days) {
    const from = new Date(`${date}T00:00:00`).getTime();
    const to = new Date(`${date}T00:00:00`);
    to.setDate(to.getDate() + 1);
    const label = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));
    lines.push(`${label}:`);
    for (const block of dayBlocks(rows, programs, kindOf, from, to.getTime())) {
      lines.push(`  ${clockTimecode(block.start).slice(0, 5)}–${clockTimecode(block.stop).slice(0, 5)} ${block.title}${block.count > 1 ? ` (${block.count} in a row)` : block.detail ? ` · ${block.detail}` : ''}`);
    }
    const ads = new Map<number, number>();
    for (const row of rows) {
      if (!['break', 'commercial', 'promo', 'bumper', 'filler'].includes(kindOf(row))) continue;
      const hour = new Date(row.start).getHours();
      ads.set(hour, (ads.get(hour) ?? 0) + (row.stop - row.start));
    }
    const heavy = [...ads].sort((a, b) => b[1] - a[1]).slice(0, 4).filter(([, ms]) => ms >= 60_000);
    if (heavy.length) lines.push(`  Most commercial time: ${heavy.map(([hour, ms]) => `${String(hour).padStart(2, '0')}:00 ${Math.round(ms / 60_000)} min`).join(', ')}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n(… cut short)` : text;
}
