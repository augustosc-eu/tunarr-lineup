import { describe, expect, it } from 'vitest';
import {
  changedPositions,
  clockTimecode,
  dayTotals,
  durationTimecode,
  moveBlock,
  moveBlockToPosition,
  moveBlockToTime,
  normalizeBlock,
  occurrenceStart,
  onAirPosition,
  shiftBlock,
  toCsv,
} from '../lib/broadcast';
import { emptyHistory, MAX_HISTORY, record, redo, undo } from '../lib/history';
import { dayRange, instancesForDay, type LineupItem } from '../lib/lineup';
import { programArtwork } from '../lib/programInfo';
import { MINUTE, mixedLineup, mixedPrograms } from './fixtures';

const ids = (lineup: LineupItem[]) => lineup.map((item) => item.id ?? item.type);
const sameItems = (a: LineupItem[], b: LineupItem[]) => expect([...a].sort((x, y) => b.indexOf(x) - b.indexOf(y))).toEqual(b);

describe('timecode', () => {
  it('formats clock time and durations', () => {
    expect(clockTimecode(new Date('2026-10-02T07:05:09').getTime())).toBe('07:05:09');
    expect(durationTimecode(0)).toBe('0:00:00');
    expect(durationTimecode(95 * MINUTE + 12_000)).toBe('1:35:12');
    expect(durationTimecode(3 * 86_400_000 + 4 * 3_600_000 + 5_000)).toBe('3d 04:00:05');
  });
});

describe('block moves', () => {
  const lineup = mixedLineup();

  it('moves a block before a later target', () => {
    const result = moveBlock(lineup, { start: 0, end: 1 }, 4)!;
    expect(ids(result.lineup)).toEqual(['prog-custom', '8f3c1b2a-0000-4000-8000-000000000002', 'prog-alpha', 'flex', 'redirect', 'prog-bravo']);
    expect(result.block).toEqual({ start: 2, end: 3 });
    sameItems(result.lineup, lineup);
  });

  it('moves a block to the end and to the start', () => {
    expect(moveBlock(lineup, { start: 1, end: 2 }, lineup.length)!.block).toEqual({ start: 4, end: 5 });
    expect(moveBlock(lineup, { start: 4, end: 5 }, 0)!.block).toEqual({ start: 0, end: 1 });
  });

  it('refuses no-op and invalid moves', () => {
    expect(moveBlock(lineup, { start: 1, end: 2 }, 2)).toBeNull();
    expect(moveBlock(lineup, { start: 1, end: 2 }, 3)).toBeNull();
    expect(moveBlock(lineup, { start: 3, end: 1 }, 0)).toBeNull();
    expect(moveBlock(lineup, { start: 0, end: 9 }, 0)).toBeNull();
  });

  it('slides a block past one neighbour at a time', () => {
    const later = shiftBlock(lineup, { start: 1, end: 2 }, 1)!;
    expect(later.block).toEqual({ start: 2, end: 3 });
    expect(later.lineup[1]).toBe(lineup[3]);
    expect(shiftBlock(lineup, { start: 0, end: 0 }, -1)).toBeNull();
    expect(shiftBlock(lineup, { start: 5, end: 5 }, 1)).toBeNull();
  });

  it('moves a block to a 1-based position', () => {
    const result = moveBlockToPosition(lineup, { start: 0, end: 1 }, 5)!;
    expect(result.block).toEqual({ start: 4, end: 5 });
    expect(result.lineup.slice(4)).toEqual([lineup[0], lineup[1]]);
    expect(moveBlockToPosition(lineup, { start: 0, end: 0 }, 1)).toBeNull();
    expect(moveBlockToPosition(lineup, { start: 0, end: 0 }, 99)!.block).toEqual({ start: 5, end: 5 });
  });

  it('normalizes anchor/focus into a block', () => {
    expect(normalizeBlock(4, 2)).toEqual({ start: 2, end: 4 });
  });
});

describe('moving to a time', () => {
  const lineup = mixedLineup(); // cycle of 140 minutes
  const date = '2026-10-02';
  const startTime = dayRange(date).from.getTime();

  it('finds the start of an occurrence nearest to a time', () => {
    expect(occurrenceStart(lineup, startTime, 1, startTime)).toBe(startTime + 30 * MINUTE);
    expect(occurrenceStart(lineup, startTime, 1, startTime + 300 * MINUTE)).toBe(startTime + (30 + 280) * MINUTE);
  });

  it('places the block at the closest boundary and reports the real start', () => {
    // Without "prog-bravo" (40 min), boundaries are at 0, 30, 40, 60, 75, 100 minutes.
    const result = moveBlockToTime(lineup, { start: 5, end: 5 }, startTime, startTime + 58 * MINUTE)!;
    expect(result.unchanged).toBe(false);
    expect(result.lineup[result.block.start]).toBe(lineup[5]);
    expect(result.start).toBe(startTime + 60 * MINUTE);
    const rows = instancesForDay(result.lineup, startTime, date);
    expect(rows.find((row) => row.item === lineup[5])!.start).toBe(startTime + 60 * MINUTE);
  });

  it('stays accurate in later cycles, where the whole cycle still includes the block', () => {
    const later = startTime + 3 * 140 * MINUTE + 58 * MINUTE;
    const result = moveBlockToTime(lineup, { start: 5, end: 5 }, startTime, later)!;
    expect(result.start).toBe(startTime + 3 * 140 * MINUTE + 60 * MINUTE);
    const rows = instancesForDay(result.lineup, startTime, date);
    expect(rows.some((row) => row.item === lineup[5] && row.start === result.start)).toBe(true);
  });

  it('reports when the block is already in the closest slot', () => {
    const result = moveBlockToTime(lineup, { start: 1, end: 1 }, startTime, startTime + 31 * MINUTE)!;
    expect(result.unchanged).toBe(true);
    expect(result.lineup).toBe(lineup);
  });
});

describe('change tracking, totals and on-air', () => {
  it('lists positions that differ from the saved lineup', () => {
    const original = mixedLineup();
    const current = moveBlock(original, { start: 0, end: 0 }, 2)!.lineup;
    expect([...changedPositions(current, JSON.parse(JSON.stringify(original)))]).toEqual([0, 1]);
    expect(changedPositions(original, JSON.parse(JSON.stringify(original))).size).toBe(0);
  });

  it('totals airtime by type within the day', () => {
    const date = '2026-10-02';
    const { from, to } = dayRange(date);
    const rows = instancesForDay(mixedLineup(), from.getTime() - 10 * MINUTE, date);
    const totals = dayTotals(rows, from.getTime(), to.getTime());
    expect(totals.total).toBe(24 * 60 * MINUTE);
    expect(Object.values(totals.byType).reduce((a, b) => a + b, 0)).toBe(totals.total);
    expect(totals.byType.flex).toBeGreaterThan(0);
  });

  it('finds the row on air', () => {
    const rows = instancesForDay(mixedLineup(), 0, '1970-01-01');
    const now = rows[3].start + 1;
    expect(onAirPosition(rows, now)).toBe(3);
    expect(onAirPosition([], now)).toBe(-1);
  });
});

describe('program log CSV', () => {
  it('quotes values and neutralizes spreadsheet formulas', () => {
    const csv = toCsv(['Title', 'Detail'], [['=HYPERLINK("x")', 'a, "b"'], ['Plain', '-1']]);
    expect(csv).toBe('Title,Detail\r\n"\'=HYPERLINK(""x"")","a, ""b"""\r\nPlain,\'-1\r\n');
  });
});

describe('edit history', () => {
  const a = mixedLineup();
  const b = shiftBlock(a, { start: 0, end: 0 }, 1)!.lineup;
  const c = shiftBlock(b, { start: 1, end: 1 }, 1)!.lineup;
  const entry = (label: string, before: LineupItem[], after: LineupItem[]) => ({ label, before, after, blockBefore: { start: 0, end: 0 }, blockAfter: { start: 1, end: 1 } });

  it('undoes and redoes step by step', () => {
    let history = record(record(emptyHistory, entry('one', a, b)), entry('two', b, c));
    const first = undo(history)!;
    expect(first.entry.label).toBe('two');
    expect(first.entry.before).toBe(b);
    history = first.history;
    const second = undo(history)!;
    expect(second.entry.before).toBe(a);
    expect(undo(second.history)).toBeNull();
    const again = redo(second.history)!;
    expect(again.entry.after).toBe(b);
    expect(again.history.future.map((item) => item.label)).toEqual(['two']);
  });

  it('drops redo after a new edit and caps its length', () => {
    const undone = undo(record(emptyHistory, entry('one', a, b)))!.history;
    expect(record(undone, entry('new', a, c)).future).toEqual([]);
    let long = emptyHistory;
    for (let i = 0; i < MAX_HISTORY + 5; i += 1) long = record(long, entry(String(i), a, b));
    expect(long.past).toHaveLength(MAX_HISTORY);
    expect(long.past[0].label).toBe('5');
  });
});

describe('artwork URLs', () => {
  const programs = { '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a': { program: { title: 'X' } } };
  const content = { type: 'content', id: '0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a', duration: 1 };

  it('points live programs at the companion artwork route only', () => {
    expect(programArtwork(content, programs, true)).toBe('/api/tunarr/programs/0e2d2a41-5f2f-4a7e-9d3a-2b1f0c9e8d7a/artwork/poster');
    expect(programArtwork(content, programs, true, 'thumbnail')).toMatch(/\/artwork\/thumbnail$/);
  });

  it('shows nothing in demo mode, for flex items, or for unknown ids', () => {
    expect(programArtwork(content, programs, false)).toBeUndefined();
    expect(programArtwork({ type: 'flex', duration: 1 }, programs, true)).toBeUndefined();
    expect(programArtwork({ type: 'content', id: '../../etc', duration: 1 }, programs, true)).toBeUndefined();
    expect(programArtwork(mixedLineup()[0], mixedPrograms(), true)).toBeUndefined();
  });

  it('uses embedded images and ignores remote icon URLs', () => {
    expect(programArtwork({ ...content, icon: 'data:image/png;base64,AAAA' }, programs, false)).toBe('data:image/png;base64,AAAA');
    expect(programArtwork({ ...content, icon: 'http://127.0.0.1:32400/thumb' }, programs, false)).toBeUndefined();
  });
});
